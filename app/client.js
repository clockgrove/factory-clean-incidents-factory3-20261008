// Each epoch owns every success, failure and cleanup write for its intent.
// Result transitions also supersede detail and export writers. Back supersedes
// only detail; exporting never changes results. Late real requests are ignored.
const $=id=>document.getElementById(id), form=$('filters');
let optionsEpoch=0, queryEpoch=0, detailEpoch=0, exportEpoch=0, data=null, page=1, currentDetail=null;
// Filter intent exists independently of asynchronously rendered checkboxes.
const filterKeys=['service','severity','status'];
let selectedFilters=Object.fromEntries(filterKeys.map(key=>[key,[]]));
const params=()=>{const p=new URLSearchParams(new FormData(form));for(const key of filterKeys){p.delete(key);for(const value of selectedFilters[key])p.append(key,value);}p.set('page',page);return p;};
const active=()=>{const p=params();p.delete('page');return p.toString();};
async function get(url,signal){const r=await fetch(url,{signal});if(!r.ok)throw Error('Request failed');return r.json();}
function cancelDetail(){detailEpoch++;currentDetail=null;$('detail').hidden=true;$('results').hidden=false;}
function invalidateExport(){exportEpoch++;$('export-status').textContent='';$('export').disabled=false;}
function selectionText(){const p=params();$('selections').textContent=[p.get('q')&&`Search: ${p.get('q')}`,...['service','severity','status'].map(k=>p.getAll(k).length?`${k}: ${p.getAll(k).join(', ')}`:''),p.get('from')&&`From ${p.get('from')} UTC`,p.get('to')&&`Through ${p.get('to')} UTC`].filter(Boolean).join(' · ')||'All incidents · No filters applied';}
async function load(reset=false){
 if(reset)page=1;cancelDetail();invalidateExport();selectionText();const epoch=++queryEpoch;
 $('rows').replaceChildren();$('chart').replaceChildren();$('daily').replaceChildren();$('chart-range').textContent='';for(const key of ['total','unresolved','high'])$(key).textContent='—';$('empty').hidden=true;$('page').textContent='Loading page…';$('status').textContent='Loading incidents…';$('retry').hidden=true;$('previous').disabled=$('next').disabled=true;$('results').setAttribute('aria-busy','true');
 try{const result=await get('/api/incidents?'+params());if(epoch!==queryEpoch)return;data=result;page=result.page;render();if(!currentDetail)$('results').hidden=false;$('status').textContent=`${result.total} incidents loaded`;}
 catch(e){if(epoch!==queryEpoch)return;$('page').textContent='Results unavailable';$('status').textContent='Could not load incidents. Your selections are preserved.';$('retry').hidden=false;}
 finally{if(epoch===queryEpoch){$('results').removeAttribute('aria-busy');$('previous').disabled=!data||page<=1||!$('retry').hidden;$('next').disabled=!data||page>=data.pages||!$('retry').hidden;}}
}
function render(){for(const k of ['total','unresolved','high'])$(k).textContent=data[k].toLocaleString();$('rows').replaceChildren();for(const r of data.rows){const tr=document.createElement('tr');const td=document.createElement('td'), b=document.createElement('button');b.textContent=r.id;b.onclick=()=>openDetail(r.id);td.append(b);const title=document.createElement('small');title.textContent=r.title;td.append(title);tr.append(td);for(const k of ['service','severity','status','openedAt']){const cell=document.createElement('td');cell.textContent=r[k];tr.append(cell);}$('rows').append(tr);}
 $('page').textContent=`Page ${data.page} of ${data.pages}`;$('empty').hidden=data.total!==0;$('chart').replaceChildren();$('daily').replaceChildren();const max=Math.max(1,...data.daily.map(x=>x[1]));$('chart-range').textContent=data.daily.length?`${data.daily[0][0]} → ${data.daily.at(-1)[0]} · Peak: ${max} incidents / day`: 'No daily counts for these selections.';for(const [date,count] of data.daily){const bar=document.createElement('span');bar.style.height=`${count/max*100}%`;bar.title=`${date}: ${count}`;$('chart').append(bar);const li=document.createElement('li');li.textContent=`${date}: ${count} incidents`;$('daily').append(li);}}
async function openDetail(id){currentDetail=id;const epoch=++detailEpoch;invalidateExport();$('results').hidden=true;$('detail').hidden=false;$('detail-title').textContent=id;$('detail-fields').replaceChildren();$('detail-status').textContent='Loading details…';$('detail-retry').hidden=true;$('back').focus();try{const row=await get('/api/incidents/'+encodeURIComponent(id));if(epoch!==detailEpoch||currentDetail!==id)return;for(const [key,value]of Object.entries(row)){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=Array.isArray(value)?value.join(', '):value??'—';$('detail-fields').append(dt,dd);}$('detail-status').textContent='';}catch{if(epoch===detailEpoch&&currentDetail===id){$('detail-status').textContent='Could not load details.';$('detail-retry').hidden=false;}}}
$('back').onclick=()=>{const id=currentDetail;cancelDetail();[...$('rows').querySelectorAll('button')].find(b=>b.textContent===id)?.focus();};$('detail-retry').onclick=()=>openDetail(currentDetail);
form.addEventListener('submit',e=>e.preventDefault());form.addEventListener('input',e=>{if(e.target.type==='checkbox'){const key=e.target.name;selectedFilters[key]=[...form.querySelectorAll('input[type=checkbox]')].filter(el=>el.name===key&&el.checked).map(el=>el.value);}load(true);});$('clear').onclick=()=>{form.reset();selectedFilters=Object.fromEntries(filterKeys.map(key=>[key,[]]));load(true);};$('retry').onclick=()=>load();
$('previous').onclick=()=>{if(page>1){page--;load();}};$('next').onclick=()=>{if(data&&page<data.pages){page++;load();}};
let views=Object.create(null);try{views=Object.assign(Object.create(null),JSON.parse(localStorage.getItem('incident-views')||'{}'));}catch{}
function viewOptions(){const selected=$('views').value;$('views').replaceChildren(new Option('Choose a view',''));for(const name of Object.keys(views))$('views').append(new Option(name,name));$('views').value=selected;}
function persist(){try{localStorage.setItem('incident-views',JSON.stringify(views));viewOptions();$('view-message').textContent='Saved views updated.';}catch{$('view-message').textContent='Browser storage is unavailable.';}}
$('save').onclick=()=>{const name=$('view-name').value.trim();if(!name){$('view-message').textContent='Enter a view name.';return;}views[name]=active();persist();$('views').value=name;};
$('open-view').onclick=()=>{const saved=views[$('views').value];if(saved===undefined)return;const p=new URLSearchParams(saved);selectedFilters=Object.fromEntries(filterKeys.map(key=>[key,p.getAll(key)]));form.reset();for(const el of form.elements){if(!el.name)continue;if(el.type==='checkbox')el.checked=p.getAll(el.name).includes(el.value);else if(p.has(el.name))el.value=p.get(el.name);}load(true);};$('delete-view').onclick=()=>{delete views[$('views').value];persist();};viewOptions();
$('export').onclick=async()=>{const epoch=++exportEpoch;$('export').disabled=true;$('export-status').textContent='Preparing CSV…';try{const r=await fetch('/api/export?'+params());if(!r.ok)throw Error();const blob=await r.blob();if(epoch!==exportEpoch)return;const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='incidents.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),0);$('export-status').textContent='CSV exported.';}catch{if(epoch===exportEpoch)$('export-status').textContent='Export failed. Use Export CSV to retry current selections.';}finally{if(epoch===exportEpoch)$('export').disabled=false;}};
// Metadata completion never navigates or writes result/detail/export state.
// Its epoch owns only choices, options status, options retry and metadata cleanup.
async function loadOptions(){
 const epoch=++optionsEpoch;
 $('options-status').textContent='Loading filter choices…';
 $('options-retry').hidden=true;$('choices').setAttribute('aria-busy','true');
 try{
  const options=await get('/api/options');if(epoch!==optionsEpoch)return;
  const groups=[];
  for(const [key,values]of Object.entries(options)){
   const fs=document.createElement('fieldset'),legend=document.createElement('legend');
   legend.textContent=key[0].toUpperCase()+key.slice(1);fs.append(legend);
   for(const value of values){
    const label=document.createElement('label'),input=document.createElement('input');
    input.type='checkbox';input.name=key;input.value=value;
    input.checked=selectedFilters[key].includes(value);
    label.append(input,document.createTextNode(value));fs.append(label);
   }
   groups.push(fs);
  }
  $('choices').replaceChildren(...groups);
  $('options-status').textContent='Filter choices ready.';
 }catch{
  if(epoch!==optionsEpoch)return;
  $('options-status').textContent='Could not load filter choices. Your selections are preserved.';
  $('options-retry').hidden=false;
 }finally{if(epoch===optionsEpoch)$('choices').removeAttribute('aria-busy');}
}
$('options-retry').onclick=()=>loadOptions();
load();
loadOptions();
