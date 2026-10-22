function liveMetadata(){
 const time=new Date(data.refreshedAt).toLocaleString('en-US',{timeZone:'America/Chicago'});
 $('#refresh-label').textContent='NetSuite · Refreshed '+time+' CT';
 const banner=document.querySelector('.demo-banner > div');if(banner)banner.innerHTML='<b>Live NetSuite · Read-only</b><span> Refreshed '+esc(time)+' CT. '+data.settingsMissing+' items have no reorder point and receive no purchase suggestion; '+data.issues.length+' order lines need review.</span>';
 const source=document.querySelector('#catalog-view .source');if(source)source.textContent='NetSuite · Complete item pull';
 $('#connection-view').innerHTML='<div class="setup-card"><h2>NetSuite is connected</h2><p>Account 3646375 · Certificate authentication · Read-only data retrieval.</p><p>Last successful refresh: '+esc(time)+' CT.</p><p>'+data.sourceCounts.activeItems+' active items, '+data.sourceCounts.uninspectedOrders+' uninspected Pending Fulfillment orders, and '+data.sourceCounts.openPOs+' open purchase orders, and '+(data.sourceCounts.openWorkOrders??'not yet connected')+' open work orders.</p><p>Stock is parent Total On Hand. Reorder settings source: '+esc(data.settingsConnection)+'. Missing values remain blank. Planned, Released and In Process work orders count; built and closed orders are excluded. Remaining builds add supply, and unconsumed component requirements add demand. Production start dates control the demand window; missing start dates are included today. Production end dates control receipt timing. Purchase quantities and sales demand use base quantities.</p><p>NetSuite items, orders, inspection checkboxes, inventory and commitments are never changed.</p><h3>Records needing review</h3><div class="table-scroll"><table><thead><tr><th>Order</th><th>Item</th><th>Reason</th></tr></thead><tbody>'+data.issues.map(i=>'<tr><td>'+esc(i.order)+'</td><td>'+esc(i.item||i.itemId)+'</td><td>'+esc(i.reason)+'</td></tr>').join('')+'</tbody></table></div></div>';
}
let refreshing=false;
// A host error page (HTML) instead of JSON means the app stopped or the request was cut off.
async function readJson(response){const text=await response.text();try{return JSON.parse(text)}catch{throw new Error('The server returned an unexpected response (HTTP '+response.status+'). Check that the app is still running, then try again.')}}
async function refreshLive(mode){
 if(refreshing)return;refreshing=true;$('#update-items').disabled=true;$('#refresh-data').disabled=true;
 $('#sync-title').textContent=mode==='items'?'Update items':'Refresh report';$('#preview-sync').hidden=true;$('#export-sync').hidden=true;$('#sync-body').innerHTML='<p id="live-progress">Reading NetSuite. Your last successful report stays available.</p>';$('#sync-dialog').showModal();
 try{
  const session=await readJson(await fetch('/api/session'));
  const response=await fetch('/api/refresh',{method:'POST',headers:{'Content-Type':'application/json','X-Planner-CSRF':session.csrf},body:JSON.stringify({mode})});
  const started=await readJson(response);if(!response.ok)throw new Error(started.error||'Refresh failed');
  // The refresh runs on the server; poll until it finishes, then load the new report.
  for(let failures=0;;){await new Promise(r=>setTimeout(r,1500));let s;
   try{s=await readJson(await fetch('/api/status'));failures=0}catch(e){if(++failures>=8)throw e;continue}
   const p=$('#live-progress');if(p)p.textContent=s.message||'Reading NetSuite…';
   if(!s.busy){if(s.error)throw new Error(s.error);break}}
  const reportResponse=await fetch('/api/report'),result=await readJson(reportResponse);if(!reportResponse.ok)throw new Error(result.error||'Could not load the refreshed report');
  result.lines.forEach(l=>l.preRolledUp=true);data=result;catalog.splice(0,catalog.length,...result.catalog);productLines=[...new Set(data.materials.map(m=>m.productLine))].sort();selectedProductLines=new Set(productLines);materialPage=0;catalogPage=0;
  renderCatalog();renderProductPicker();render();liveMetadata();syncPreviewReport=result.changeReport;
  const report=mode==='items'?'<div class="sync-summary">'+Object.entries(syncPreviewReport.counts).map(([key,n])=>'<div><b>'+nf.format(n)+'</b><small>'+esc(key)+'</small></div>').join('')+'</div><div class="table-scroll"><table><thead><tr><th>Action</th><th>Item</th><th>Field</th><th>Before</th><th>After</th></tr></thead><tbody>'+syncPreviewReport.changes.slice(0,200).map(c=>'<tr><td>'+esc(c.action)+'</td><td>'+esc(c.sku)+' · '+esc(c.id)+'</td><td>'+esc(c.field)+'</td><td>'+esc(c.before??'—')+'</td><td>'+esc(c.after??'—')+'</td></tr>').join('')+'</tbody></table></div><p>Showing up to 200 changes. Export contains every change. Changes apply only to this planner.</p>':'';
  $('#sync-body').innerHTML='<div class="demo-banner"><b>Live refresh completed</b></div><p>'+data.sourceCounts.items+' items read. '+data.sourceCounts.uninspectedOrders+' uninspected orders and '+data.sourceCounts.openPOs+' open POs and '+(data.sourceCounts.openWorkOrders??0)+' open work orders.</p><p>'+data.settingsMissing+' items without readable reorder points show no purchase suggestion. '+data.issues.length+' order lines need review.</p>'+report;
  $('#export-sync').hidden=mode!=='items';
 }catch(e){$('#sync-body').innerHTML='<div class="demo-banner"><b>Refresh could not complete</b></div><p>'+esc(e.message)+'</p><p>Your last complete report has been retained.</p>';}finally{refreshing=false;$('#update-items').disabled=false;$('#refresh-data').disabled=false;}
}
if(data.refreshedAt)liveMetadata();else{const s=document.querySelector('#page-subtitle');if(s)s.textContent='No NetSuite report yet. Click Refresh report to load one.'}
