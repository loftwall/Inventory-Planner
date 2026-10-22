import {fileURLToPath} from 'node:url';import {resolve} from 'node:path';import {connection} from './config.mjs';
import {readFile,writeFile,rename,mkdir} from 'node:fs/promises';
import {NetSuiteReader} from './client.mjs';
import {rollupOrders} from '../planner/rollup.mjs';
import {bucket,plan} from '../planner/core.mjs';
import {pullSettings,pullSavedSearchSettings} from './settings.mjs';
import {optimalPacking} from './optimal-packing.mjs';
import {compareItems} from '../planner/sync.mjs';
import {usageMonths,rollupUsage} from '../planner/usage.mjs';
export const root=fileURLToPath(new URL('../',import.meta.url));
export const stateDir=resolve(process.env.PLANNER_DATA_DIR||root+'/data');
const num=v=>v===null||v===undefined||v===''?null:Number(v);
export const date=v=>{if(!v)return null;const m=String(v).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);return m?`${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`:String(v).slice(0,10)};
export const truth=v=>v===true||v==='T';
export const today=()=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date());const get=t=>p.find(x=>x.type===t).value;return get('year')+'-'+get('month')+'-'+get('day')};
export async function reader(){return new NetSuiteReader(connection())}
async function all(r,q,onProgress,label){let out=[],offset=0;for(;;){const p=await r.query(q,{limit:1000,offset});out.push(...p.items);onProgress?.(`${label}: ${out.length.toLocaleString()} records read`);if(!p.hasMore)break;if(!p.items.length||offset>=99000)throw new Error('Incomplete paginated pull');offset+=p.items.length;}return out;}
export async function pullCatalog(r,onProgress){
 const count=async()=>Number((await r.query('SELECT COUNT(*) AS n FROM item',{limit:1})).items[0].n);
 const before=await count();
 const raw=await all(r,'SELECT id, itemid, itemtype, isinactive, totalquantityonhand, lastpurchaseprice, custitemparentitem, BUILTIN.DF(custitemparentitem) AS parentname, custitemparentyield, BUILTIN.DF(class) AS productline, displayname, description FROM item ORDER BY id',onProgress,'Items');
 const after=await count();if(before!==after||raw.length!==after||new Set(raw.map(i=>i.id)).size!==after)throw new Error('Item list changed during retrieval or was incomplete. Previous data retained.');
 const items=raw.map(i=>({id:Number(i.id),sku:i.itemid,display:i.displayname||'',description:i.description||'',type:i.itemtype,parent:i.parentname||'',parentInternalId:num(i.custitemparentitem),yield:num(i.custitemparentyield),line:i.productline||'Unassigned',active:!truth(i.isinactive),onHand:num(i.totalquantityonhand),price:num(i.lastpurchaseprice)}));
 return {items,complete:true,filtered:false,scope:'3646375:inventory-planner:all-items',total:after};
}
export const usageHistoryMonths=25;
const excludedLineTypes="('ShipItem','Discount','Subtotal','Markup','Description','EndGroup','Group')";
// Read-only monthly usage: sales-order shipments (not transfer shipments) and work-order component consumption.
// Each source keeps its last successful read if a query fails, so a history problem never blocks the refresh.
export async function pullUsageHistory(r,catalog,previousRaw,onProgress){
 const months=usageMonths(today().slice(0,7),usageHistoryMonths),start=months[0]+'-01',month="TO_CHAR(t.trandate,'YYYY-MM')";
 const sales=link=>`SELECT ${month} AS month,l.item,SUM(ABS(l.quantity)) AS qty FROM transaction t INNER JOIN transactionline l ON l.transaction=t.id INNER JOIN transaction s ON s.id=${link} WHERE t.type='ItemShip' AND s.type='SalesOrd' AND t.trandate>=TO_DATE('${start}','YYYY-MM-DD') AND l.mainline='F' AND l.taxline='F' AND l.item IS NOT NULL AND l.itemtype NOT IN ${excludedLineTypes} GROUP BY ${month},l.item ORDER BY ${month},l.item`;
 const work=`SELECT ${month} AS month,l.item,SUM(ABS(l.quantity)) AS qty FROM transaction t INNER JOIN transactionline l ON l.transaction=t.id WHERE t.type IN ('WOIssue','WOCompl') AND (t.type='WOIssue' OR l.quantity<0) AND t.trandate>=TO_DATE('${start}','YYYY-MM-DD') AND l.mainline='F' AND l.item IS NOT NULL AND l.itemtype IN ('InvtPart','Assembly') GROUP BY ${month},l.item ORDER BY ${month},l.item`;
 const read=async(queries,label,source)=>{let error;for(const q of queries){try{return {rows:(await all(r,q,onProgress,label)).map(x=>({month:x.month,item:Number(x.item),qty:Number(x.qty),source})),readAt:new Date().toISOString(),error:null}}catch(e){error=e}}
  const kept=previousRaw?.[source];return {rows:kept?.rows||[],readAt:kept?.readAt||null,error:error.message}};
 onProgress?.('Reading shipment history');
 const salesRaw=await read([sales('l.createdfrom'),sales('t.createdfrom')],'Shipment history','sales');
 onProgress?.('Reading work-order consumption history');
 const workRaw=await read([work],'Work-order history','workOrder');
 const raw={sales:salesRaw,workOrder:workRaw},rolled=rollupUsage([...salesRaw.rows,...workRaw.rows],catalog,months);
 return {raw,history:{...rolled,from:start,through:today(),sources:{sales:{readAt:salesRaw.readAt,error:salesRaw.error},workOrders:{readAt:workRaw.readAt,error:workRaw.error}}}};
}
export async function pullReport({updateItems=false,readSettings=true,onProgress}={}){
 await mkdir(stateDir,{recursive:true,mode:0o700});const r=await reader();let previous;
 try{previous=JSON.parse(await readFile(stateDir+'/live-report.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e;}
 onProgress?.('Reading NetSuite items');
 // Stock and item settings are refreshed together, so every report uses current parent relationships.
 const cat=await pullCatalog(r,onProgress);
 let changeReport=previous?compareItems(previous.catalog,cat,previous.scope):{counts:{added:cat.items.length,updated:0,removed:0,unchanged:0},changes:cat.items.map(i=>({action:'Added',id:i.id,sku:i.sku,field:'Item',before:null,after:i.sku})),total:cat.items.length};
 // Guard against a reduced role scope removing most of the active catalog.
 if(previous&&changeReport.counts.removed>Math.max(20,previous.catalog.length*.05))throw new Error('Unexpectedly large item removal. Check read access before replacing the catalog.');
 onProgress?.('Reading Pending Fulfillment sales orders');
 const sales=await all(r,"SELECT t.id AS orderid,t.tranid,TO_CHAR(t.shipdate,'YYYY-MM-DD') AS shipdate,t.custbodyqa_check,l.id AS lineid,l.item,l.itemtype,l.quantity,l.quantityshiprecv,l.isclosed,l.mainline,l.taxline FROM transaction t INNER JOIN transactionline l ON l.transaction=t.id WHERE t.type='SalesOrd' AND t.status='B' AND l.mainline='F' AND l.taxline='F' AND l.item IS NOT NULL AND l.itemtype NOT IN ('ShipItem','Discount','Subtotal','Markup','Description','EndGroup','Group') ORDER BY t.id,l.id",onProgress,'Sales order lines');
 onProgress?.('Reading open purchase orders');
 const purchases=await all(r,"SELECT t.id AS orderid,t.tranid,t.status,t.approvalstatus,TO_CHAR(t.custbodypo_expected_arrival_date,'YYYY-MM-DD') AS arrival,l.id AS lineid,l.item,l.itemtype,l.quantity,l.quantityshiprecv,l.isclosed FROM transaction t INNER JOIN transactionline l ON l.transaction=t.id WHERE t.type='PurchOrd' AND t.status IN ('B','D','E','F') AND l.mainline='F' AND l.taxline='F' AND l.item IS NOT NULL AND l.itemtype NOT IN ('ShipItem','Discount','Subtotal','Markup','Description','EndGroup','Group') ORDER BY t.id,l.id",onProgress,'Purchase order lines');
 onProgress?.('Reading open work orders');
 const workOrders=await all(r,"SELECT t.id AS orderid,t.tranid,t.status,TO_CHAR(t.startdate,'YYYY-MM-DD') AS startdate,TO_CHAR(t.enddate,'YYYY-MM-DD') AS enddate,l.id AS lineid,l.item,l.itemtype,l.mainline,l.quantity,l.quantityshiprecv,l.isclosed FROM transaction t INNER JOIN transactionline l ON l.transaction=t.id WHERE t.type='WorkOrd' AND t.status IN ('A','B','D') AND l.item IS NOT NULL AND l.itemtype IN ('InvtPart','Assembly') ORDER BY t.id,l.id",onProgress,'Work order lines');
 const workStatus=s=>({A:'Planned',B:'Released',D:'In Process'}[s]);
 const workComponents=workOrders.filter(l=>!truth(l.mainline)&&!truth(l.isclosed)).map(l=>({id:'wo-'+l.orderid+'-'+l.lineid,order:l.tranid,orderInternalId:'wo-'+l.orderid,itemId:Number(l.item),qty:Math.abs(Number(l.quantity)),shipped:Math.abs(Number(l.quantityshiprecv||0)),ship:date(l.startdate),status:'Pending Fulfillment',source:'workOrder',workStatus:workStatus(l.status),inspected:false,closed:false}));
 await writeFile(stateDir+'/raw-orders.json',JSON.stringify({sales,purchases,workOrders}),{mode:0o600});
 const day=today(),orders=sales.map(l=>({id:l.orderid+'-'+l.lineid,order:l.tranid,orderInternalId:l.orderid,itemId:Number(l.item),qty:Math.abs(Number(l.quantity)),shipped:Math.abs(Number(l.quantityshiprecv||0)),ship:date(l.shipdate),status:'Pending Fulfillment',inspected:truth(l.custbodyqa_check),closed:truth(l.isclosed)}));
 const rollup=rollupOrders(orders,cat.items,day,90,true,bucket,optimalPacking),issues=rollup.details.filter(d=>d.error||d.ignored).map(d=>({order:d.order,itemId:d.itemId,item:d.item?.sku||'',reason:d.error||d.reason}));
 const workRollup=rollupOrders(workComponents,cat.items,day,90,true,bucket,optimalPacking);issues.push(...workRollup.details.filter(d=>d.error||d.ignored).map(d=>({order:d.order,itemId:d.itemId,item:d.item?.sku||'',reason:d.error||d.reason})));
 const rootIds=new Set([...rollup.groups,...workRollup.groups].filter(g=>g.purchasing).map(g=>String(g.parent.id)));
 const parents=cat.items.filter(i=>['InvtPart','Assembly'].includes(i.type)&&(!i.parent||i.parent===i.sku||i.parentInternalId===i.id)&&(i.active||rootIds.has(String(i.id))));
 let cache={};try{cache=JSON.parse(await readFile(stateDir+'/settings-cache.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e;}
 // Only inventory/assembly purchasing items have inventory locations. Read every location; no location filter.
 const cfg=connection();
 if(readSettings&&cfg.settingsSearchId)cache=await pullSavedSearchSettings(r,cat.items,cfg,onProgress);
 else if(readSettings&&cfg.settingsUrl)cache=await pullSettings(r,cat.items,cfg,onProgress);
 const eligible=readSettings&&cfg.settingsMode==='record'?parents.filter(i=>['InvtPart'].includes(i.type)):[];let completed=0;
 let settingsIndex=0;
 const workers=Array.from({length:4},async()=>{for(;;){const i=eligible[settingsIndex++];if(!i)break;
  onProgress?.(`Reading reorder settings: ${++completed} of ${eligible.length}`);
  try{
   const record=await r.readRecord('inventoryItem/'+i.id+'?expandSubResources=true');
   const loc=record.locations?.items||[];
   const points=loc.map(l=>num(l.reorderPoint)).filter(Number.isFinite),preferred=loc.map(l=>num(l.preferredStockLevel)).filter(Number.isFinite);
   const direct=num(record.reorderPoint);
   cache[i.id]={readAt:new Date().toISOString(),reorder:direct??(points.length?points.reduce((a,b)=>a+b,0):null),preferred:num(record.preferredStockLevel)??(preferred.length?preferred.reduce((a,b)=>a+b,0):null),locationCount:loc.length,locations:loc.map(l=>({id:l.location?.id||l.locationId,reorder:num(l.reorderPoint),preferred:num(l.preferredStockLevel)})),unit:record.stockUnit?.refName||'base unit',source:loc.length?'Combined item locations':'Item record',error:null};
  }catch(e){cache[i.id]={readAt:new Date().toISOString(),reorder:null,preferred:null,error:e.message,unit:'base unit'};}
 }});await Promise.all(workers);
 await writeFile(stateDir+'/settings-cache.json',JSON.stringify(cache),{mode:0o600});
 const materials=parents.map(i=>({id:'item-'+i.id,internalId:i.id,sku:i.sku,name:i.description||i.display||i.sku,productLine:i.line,unit:cache[i.id]?.unit||'base unit',onHand:i.onHand,reorder:cache[i.id]?.reorder??null,preferred:cache[i.id]?.preferred??null,price:i.price,hasDemandData:true,hasSupplyData:true,sample:false,live:true,settingsSource:cache[i.id]?.source,settingsError:cache[i.id]?.error,locationCount:cache[i.id]?.locationCount}));
 const validMaterials=new Set(materials.map(m=>m.id)),lineGroups=new Map();
 for(const d of [...rollup.details,...workRollup.details]){if(d.treatment==='closed'||d.ignored)continue;
  if(d.error){const target=d.parent;if(target&&validMaterials.has('item-'+target.id))lineGroups.set(d.order+':error:'+d.itemId,{id:d.id,order:d.order,material:'item-'+target.id,ordered:0,shipped:0,factor:1,status:d.status,inspected:d.inspected,ship:d.ship,packingError:d.error});continue;}
  for(const level of d.usage.filter(u=>!u.parent.parent||u.parent.parent===u.parent.sku||u.parent.parentInternalId===u.parent.id)){
   const key=d.orderInternalId+':'+level.parent.id;if(!lineGroups.has(key))lineGroups.set(key,{id:key,order:d.order,material:'item-'+level.parent.id,preRolledUp:true,ordered:level.qty,shipped:0,factor:1,ship:d.ship,status:d.source==='workOrder'?d.workStatus:'Pending Fulfillment',source:d.source||'salesOrder',inspected:false,closed:false,customer:'',product:'',sourceItems:[],calculation:''});
   const line=lineGroups.get(key);line.sourceItems.push({id:d.itemId,sku:d.item.sku,remaining:Math.max(0,d.qty-d.shipped),path:d.path});line.product=line.sourceItems.map(i=>i.sku).join(' + ');line.intermediateUsage=d.usage.filter(u=>u.parent.parent&&u.parent.parent!==u.parent.sku).map(u=>({sku:u.parent.sku,qty:u.qty}));line.calculation=line.sourceItems.map(i=>i.remaining+' '+i.sku+(i.path.length?' → '+i.path.map(p=>'yield '+p.yield+' '+p.parent).join(' → '):'')).join('; ')+' · shared order total'+(line.intermediateUsage.length?' · intermediate totals: '+line.intermediateUsage.map(u=>u.qty+' '+u.sku).join(', '):'');
  }
 }
 const receipts=purchases.filter(l=>!truth(l.isclosed)&&(l.approvalstatus==null||l.approvalstatus==='2')).map(l=>({id:l.orderid+'-'+l.lineid,order:l.tranid,material:'item-'+l.item,ordered:Math.abs(Number(l.quantity)),received:Math.abs(Number(l.quantityshiprecv||0)),qty:Math.max(0,Math.abs(Number(l.quantity))-Math.abs(Number(l.quantityshiprecv||0))),date:date(l.arrival),approved:true,closed:false,vendor:'',live:true,sample:false})).filter(l=>l.qty>0&&validMaterials.has(l.material));
 const workOrderReceipts=workOrders.filter(l=>truth(l.mainline)&&!truth(l.isclosed)).map(l=>({id:'wo-'+l.orderid,order:l.tranid,material:'item-'+l.item,ordered:Math.abs(Number(l.quantity)),built:Math.abs(Number(l.quantityshiprecv||0)),qty:Math.max(0,Math.abs(Number(l.quantity))-Math.abs(Number(l.quantityshiprecv||0))),date:date(l.enddate),status:workStatus(l.status),closed:false,live:true})).filter(l=>l.qty>0&&validMaterials.has(l.material));
 const excludedBuilds=workOrders.filter(l=>truth(l.mainline)&&!truth(l.isclosed)&&!validMaterials.has('item-'+l.item));
 if(excludedBuilds.length)throw new Error('Work-order output is a child item; its supply mapping needs review before refreshing');
 let usageRaw=null;try{usageRaw=JSON.parse(await readFile(stateDir+'/usage-raw.json','utf8'))}catch(e){if(e.code!=='ENOENT')throw e;}
 const usage=await pullUsageHistory(r,cat.items,usageRaw,onProgress);
 await writeFile(stateDir+'/usage-raw.json',JSON.stringify(usage.raw),{mode:0o600});
 const usageHistory={...usage.history,materials:Object.fromEntries(Object.entries(usage.history.materials).filter(([id])=>validMaterials.has(id)))};
 const report={scope:cat.scope,catalog:cat.items,materials,lines:[...lineGroups.values()],receipts,workOrderReceipts,workOrdersConnected:true,issues,source:'NetSuite',settingsConnection:cfg.settingsMode||'pending',account:'3646375',refreshedAt:new Date().toISOString(),changeReport,usageHistory,settingsMissing:materials.filter(m=>m.reorder===null).length,sourceCounts:{items:cat.items.length,activeItems:cat.items.filter(i=>i.active).length,salesOrders:new Set(sales.map(l=>l.orderid)).size,uninspectedOrders:new Set(orders.filter(o=>!o.inspected&&!o.closed&&o.qty>o.shipped).map(o=>o.order)).size,rawSalesLines:sales.length,rawPOLines:purchases.length,rawWorkOrderLines:workOrders.length,openWorkOrders:new Set(workOrderReceipts.map(w=>w.order)).size,openPOs:new Set(receipts.map(p=>p.order)).size}};
 await mkdir(stateDir+'/history',{recursive:true,mode:0o700});
 const historyName=new Date().toISOString().replace(/[:.]/g,'-');
 await writeFile(stateDir+'/history/'+historyName+'.json',JSON.stringify(report),{mode:0o600});
 await writeFile(stateDir+'/live-report.tmp',JSON.stringify(report),{mode:0o600});await rename(stateDir+'/live-report.tmp',stateDir+'/live-report.json');
 onProgress?.('Refresh complete');return report;
}
if(process.argv.includes('--run')){const report=await pullReport({updateItems:process.argv.includes('--update-items'),readSettings:!process.argv.includes('--skip-settings'),onProgress:m=>{if(!m.startsWith('Reading reorder settings:')||Number(m.match(/: (\d+)/)?.[1])%25===0)console.log(m)}});console.log(JSON.stringify({refreshedAt:report.refreshedAt,sourceCounts:report.sourceCounts,materials:report.materials.length,missingReorder:report.settingsMissing,issues:report.issues.length}));}
