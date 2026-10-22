import http from 'node:http';import {readFile} from 'node:fs/promises';import {randomBytes} from 'node:crypto';
import {pullReport,stateDir,root} from './pull.mjs';
import {authSettings,currentUser,csrfFor,beginLogin,finishLogin,signOutCookie} from './auth.mjs';

const auth=authSettings();
const port=Number(process.env.PORT||3000),host=process.env.HOST||'0.0.0.0',origin=auth.origin||`http://127.0.0.1:${port}`;
// No in-app access gate: access to the published app is controlled by the hosting platform (Replit password protection).
const localCsrf=randomBytes(32).toString('hex');
let busy=false,message='Ready',lastError=null;

const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data))};
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const page=(res,status,title,body,headers={})=>{res.writeHead(status,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Frame-Options':'DENY','X-Content-Type-Options':'nosniff',...headers});
 res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow, noarchive, nosnippet"><title>${esc(title)}</title><style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f6f7f4;color:#1e3238;display:grid;place-items:center;min-height:100vh;margin:0}main{background:#fff;border:1px solid #e2e7e4;border-radius:12px;padding:36px;max-width:440px}a.btn{display:inline-block;background:#17634f;color:#fff;padding:11px 18px;border-radius:7px;text-decoration:none;margin-top:8px}code{background:#f0f2ef;padding:1px 4px;border-radius:4px}</style></head><body><main><h1>${esc(title)}</h1>${body}</main></body></html>`)};
const securityHeaders={'X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",'X-Content-Type-Options':'nosniff'};
const userBar=u=>`<div style="position:fixed;right:16px;bottom:12px;z-index:9;font:12px -apple-system,sans-serif;background:#fff;border:1px solid #e2e7e4;border-radius:7px;padding:6px 10px;color:#738083">${esc(u.email)} · <a href="/auth/logout" style="color:#17634f">Sign out</a></div>`;

const server=http.createServer(async(req,res)=>{
 res.setHeader('X-Robots-Tag','noindex, nofollow, noarchive, nosnippet');
 try{
  const url0=new URL(req.url,'http://x');
  if(req.method==='GET'&&url0.pathname==='/robots.txt'){
   res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});
   res.end(await readFile(root+'/public/robots.txt','utf8'));return;
  }
  if(!req.headers.host){json(res,400,{error:'Missing host'});return}
  const loopback=['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const proto=String(req.headers['x-forwarded-proto']||(loopback?'http':'https')).split(',')[0].trim();
  // Optional Microsoft 365 sign-in (auth.mjs) applies only when its settings are present.
  const reqOrigin=auth.configured?origin:proto+'://'+String(req.headers['x-forwarded-host']||req.headers.host).split(',')[0].trim();
  if(auth.configured&&req.headers.host!==new URL(origin).host){json(res,403,{error:'Invalid host'});return}
  const url=new URL(req.url,reqOrigin);

  let user=null,csrf=localCsrf;
  if(auth.configured){
   if(req.method==='GET'&&url.pathname==='/auth/login'){const l=beginLogin(auth);res.writeHead(302,{Location:l.location,'Set-Cookie':l.setCookie,'Cache-Control':'no-store'});res.end();return}
   if(req.method==='GET'&&url.pathname==='/auth/callback'){
    try{const r=await finishLogin(auth,req,url);
     if(!r.user){page(res,403,'Access not approved',`<p>${esc(r.email)} signed in, but is not on the approved user list for the Inventory Planner. Ask an administrator to add you.</p><a class="btn" href="/auth/login">Use a different account</a>`,{'Set-Cookie':r.setCookies});return}
     console.log('Sign-in: '+r.user.email);res.writeHead(302,{Location:'/','Set-Cookie':r.setCookies,'Cache-Control':'no-store'});res.end();
    }catch(e){page(res,401,'Sign-in failed',`<p>${esc(e.message)}</p><a class="btn" href="/auth/login">Try again</a>`)}
    return;
   }
   if(req.method==='GET'&&url.pathname==='/auth/logout'){res.writeHead(302,{Location:'/signed-out','Set-Cookie':signOutCookie(),'Cache-Control':'no-store'});res.end();return}
   if(req.method==='GET'&&url.pathname==='/signed-out'){page(res,200,'Signed out','<p>You have signed out of the Inventory Planner.</p><a class="btn" href="/auth/login">Sign in again</a>');return}
   user=currentUser(auth,req);
   if(!user){
    if(req.method==='GET'&&url.pathname==='/'){page(res,200,'Inventory Planner','<p>Sign in with your Loftwall Microsoft 365 account to continue.</p><a class="btn" href="/auth/login">Sign in with Microsoft</a>');return}
    json(res,401,{error:'Sign in required'});return;
   }
   csrf=csrfFor(auth,user);
  }

  if(req.method==='GET'&&url.pathname==='/'){
   const html=await readFile(root+'/server/live.html','utf8');
   res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',...securityHeaders});
   res.end(user?html.replace('</body>',userBar(user)+'</body>'):html);return;
  }
  // Without Microsoft sign-in there is no per-browser session: the host controls access. Refresh still needs the
  // CSRF token (readable only by same-origin pages) and a same-origin Origin header.
  if(req.headers.origin&&req.headers.origin!==reqOrigin){json(res,403,{error:'Invalid origin'});return}
  if(req.method==='GET'&&url.pathname==='/api/session'){json(res,200,{csrf,user:user?{email:user.email,name:user.name}:null});return}
  if(req.method==='GET'&&url.pathname==='/api/status'){json(res,200,{busy,message,error:lastError});return}
  if(req.method==='GET'&&url.pathname==='/api/report'){json(res,200,JSON.parse(await readFile(stateDir+'/live-report.json','utf8')));return}
  if(req.method==='POST'&&url.pathname==='/api/refresh'){
   if(req.headers.origin!==reqOrigin||req.headers['x-planner-csrf']!==csrf){json(res,403,{error:'Refresh must come from this planner'});return}
   if(busy){json(res,409,{error:'A refresh is already running'});return}
   let body='';for await(const chunk of req){body+=chunk;if(body.length>1000){json(res,413,{error:'Request too large'});return}}
   const {mode}=JSON.parse(body);if(!['items','report'].includes(mode)){json(res,400,{error:'Unknown refresh mode'});return}
   busy=true;lastError=null;message='Starting refresh';if(user)console.log('Refresh ('+mode+') by '+user.email);
   // Runs in the background: a long NetSuite read must not hold the request open past the host's proxy timeout.
   // The page polls /api/status and loads /api/report when the refresh finishes.
   pullReport({updateItems:mode==='items',onProgress:m=>message=m}).catch(e=>{lastError=e.message;message='Refresh failed; previous report retained';console.log('Refresh failed: '+e.message)}).finally(()=>{busy=false});
   json(res,202,{started:true});return;
  }
  json(res,404,{error:'Not found'});
 }catch(e){json(res,500,{error:e.code==='ENOENT'?'No successful report available yet':e.message})}
});
server.listen(port,host,()=>console.log('Inventory Planner on port '+port+(auth.configured?' (Microsoft 365 sign-in, '+auth.approved.size+' approved users)':' (no in-app sign-in; access controlled by the host)')));
