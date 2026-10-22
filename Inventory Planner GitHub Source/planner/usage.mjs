import {resolveParent} from './rollup.mjs';
// Historical usage: past shipments and work-order consumption by month, rolled up to purchasing parents.
// This is a reference for projecting forward; it does not change open-order demand or purchase suggestions.
export const usageMonths=(end,count)=>{const out=[];let [y,m]=end.split('-').map(Number);for(let i=0;i<count;i++){out.unshift(y+'-'+String(m).padStart(2,'0'));if(--m===0){m=12;y--}}return out};
export const usageMonthDays=month=>{const [y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m,0)).getUTCDate()};
const usageRound=n=>Math.round(n*10000)/10000;
// Same per-level conversion as order demand (yield below one = pieces per parent unit), without per-order rounding up.
export const usageParentQty=(qty,path)=>path.reduce((q,p)=>p.yield>0&&p.yield<1?q/Math.floor(1/p.yield):q*p.yield,qty);
export function rollupUsage(rows,catalog,months){
 const byId=new Map(catalog.map(i=>[String(i.id),i])),index=new Map(months.map((m,i)=>[m,i])),materials={},issues=new Map();
 for(const row of rows){
  const at=index.get(row.month),qty=Number(row.qty);if(at===undefined||!Number.isFinite(qty)||qty<=0)continue;
  const item=byId.get(String(row.item)),issue=reason=>{const key=row.item+':'+reason;const i=issues.get(key)||{itemId:row.item,item:item?.sku||'',reason,qty:0};i.qty=usageRound(i.qty+qty);issues.set(key,i)};
  if(!item){issue('Item not found');continue}
  const resolved=resolveParent(item,catalog);if(resolved.error||resolved.ignored){issue(resolved.error||resolved.reason);continue}
  const id='item-'+resolved.parent.id,source=row.source==='workOrder'?'workOrders':'sales';
  materials[id]??={sales:months.map(()=>0),workOrders:months.map(()=>0)};
  materials[id][source][at]=usageRound(materials[id][source][at]+usageParentQty(qty,resolved.path));
 }
 return {months,materials,issues:[...issues.values()]};
}
// Average daily use over the last `lookback` complete months (the current, partial month is excluded).
export function usageForecast(history,materialId,{lookback,days,currentMonth}){
 const h=history?.materials?.[materialId],months=history?.months||[];
 const totals=months.map((_,i)=>h?h.sales[i]+h.workOrders[i]:0);
 const complete=months.map((m,i)=>({m,qty:totals[i]})).filter(x=>x.m<currentMonth),used=complete.slice(-lookback);
 if(!used.length)return {months:0,total:null,monthly:null,daily:null,forecast:null,trend:null,monthToDate:null,totals};
 const total=used.reduce((s,x)=>s+x.qty,0),daysCovered=used.reduce((s,x)=>s+usageMonthDays(x.m),0),daily=total/daysCovered;
 const recent=complete.slice(-3).reduce((s,x)=>s+x.qty,0),prior=complete.slice(-6,-3).reduce((s,x)=>s+x.qty,0);
 const mtd=months.indexOf(currentMonth);
 return {months:used.length,total:usageRound(total),monthly:usageRound(total/used.length),daily,forecast:Math.ceil(daily*days),trend:complete.length>=6&&prior>0?(recent-prior)/prior:null,monthToDate:mtd<0?null:usageRound(totals[mtd]),totals};
}
