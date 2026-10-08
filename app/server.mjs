import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root = new URL('../', import.meta.url);
const fields = ['id','title','description','service','severity','status','openedAt','resolvedAt','team','region','tags'];
const priority = ['critical','high','medium','low'];
export async function createServer({beforeRequest} = {}) {
  const rows = JSON.parse(await readFile(new URL('.runtime/incidents.json', root), 'utf8'));
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (beforeRequest) await beforeRequest(req, res, url);
      if (res.destroyed) return;
      if (url.pathname === '/api/options') return json(res, Object.fromEntries(['service','severity','status'].map(k => [k, [...new Set(rows.map(r=>r[k]))].sort()])));
      if (url.pathname.startsWith('/api/incidents/')) {
        const row = rows.find(r=>r.id === decodeURIComponent(url.pathname.split('/').pop()));
        return json(res, row || {error:'Incident not found'}, row ? 200 : 404);
      }
      if (['/api/incidents','/api/export'].includes(url.pathname)) {
        const p=url.searchParams, q=(p.get('q')||'').toLowerCase();
        const matched=rows.filter(r => [r.id,r.title,r.description].some(s=>s.toLowerCase().includes(q)) && ['service','status','severity'].every(k=>!p.getAll(k).length || p.getAll(k).includes(r[k])) && (!p.get('from')||r.openedAt.slice(0,10)>=p.get('from')) && (!p.get('to')||r.openedAt.slice(0,10)<=p.get('to')));
        const direction=p.get('direction')==='asc'?1:-1;
        matched.sort((a,b)=> direction*(p.get('sort')==='severity' ? priority.indexOf(b.severity)-priority.indexOf(a.severity) : a.openedAt.localeCompare(b.openedAt)) || a.id.localeCompare(b.id));
        if (url.pathname === '/api/export') {
          const quote=v=>'"'+String(v??'').replaceAll('"','""')+'"';
          res.writeHead(200, {'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="incidents.csv"'});
          return res.end([fields.map(quote).join(','),...matched.map(r=>fields.map(k=>quote(k==='tags'?JSON.stringify(r[k]):r[k])).join(','))].join('\r\n')+'\r\n');
        }
        const size=p.get('size')==='50'?50:25, pages=Math.max(1,Math.ceil(matched.length/size)), page=Math.min(pages,Math.max(1,Math.trunc(Number(p.get('page')))||1));
        const daily={}; for(const r of matched) daily[r.openedAt.slice(0,10)]=(daily[r.openedAt.slice(0,10)]||0)+1;
        return json(res,{rows:matched.slice((page-1)*size,page*size),page,pages,total:matched.length,unresolved:matched.filter(r=>r.status!=='resolved').length,high:matched.filter(r=>['critical','high'].includes(r.severity)).length,daily:Object.entries(daily).sort()});
      }
      const files={'/':'index.html','/client.js':'client.js','/style.css':'style.css'};
      if(!files[url.pathname]) return json(res,{error:'Not found'},404);
      res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'text/javascript':url.pathname.endsWith('.css')?'text/css':'text/html'});
      res.end(await readFile(new URL(files[url.pathname],import.meta.url)));
    } catch { if(!res.destroyed) json(res,{error:'Unable to load incidents'},500); }
  });
}
function json(res,value,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(value));}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const server=await createServer(); server.listen(3000,'127.0.0.1',()=>console.log('Incident explorer: http://127.0.0.1:3000'));
  for(const signal of ['SIGINT','SIGTERM']) process.on(signal,()=>server.close());
}
