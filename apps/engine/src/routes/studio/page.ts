/**
 * HTML della pagina privata "Studio" servita dal runtime all'URL del tenant
 * (/studio). Chat-style, mobile-responsive, gated dalla sessione owner (SSO) —
 * niente login proprio. Tutte le fetch vanno su /studio/* (same-origin).
 *
 * @module routes/studio/page
 */
import { fitToModel } from './fit-dims.js';

export const STUDIO_PAGE_HTML = `<!doctype html>
<html lang="it"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex,nofollow" />
<title>Studio</title>
<style>
  :root { --bg:#0b0d10; --panel:#14171c; --line:#262b33; --fg:#e7eaee; --muted:#8b93a1; --accent:#5b8cff; --ok:#34d399; --no:#f87171; }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 -apple-system,system-ui,Segoe UI,Roboto,sans-serif; height:100vh; height:100dvh; display:flex; flex-direction:column; overscroll-behavior:none; }
  header { padding:10px 16px; padding-top:max(10px,env(safe-area-inset-top)); border-bottom:1px solid var(--line); font-weight:600; display:flex; align-items:center; gap:8px; }
  header .dot { width:8px; height:8px; border-radius:50%; background:var(--accent); }
  #log { flex:1; overflow-y:auto; padding:16px; display:flex; flex-direction:column; gap:14px; }
  .msg { max-width:760px; } .msg.me { align-self:flex-end; background:var(--panel); border:1px solid var(--line); border-radius:12px 12px 2px 12px; padding:8px 12px; white-space:pre-wrap; }
  .msg.ai { align-self:flex-start; } .msg.ai img, .msg.ai video { max-width:min(512px,100%); width:100%; border-radius:10px; border:1px solid var(--line); display:block; }
  .msg .cap { color:var(--muted); font-size:12px; margin-top:4px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .vote { cursor:pointer; font-size:18px; opacity:.6; user-select:none; }
  .vote.on-up { opacity:1; filter:drop-shadow(0 0 4px var(--ok)); } .vote.on-down { opacity:1; filter:drop-shadow(0 0 4px var(--no)); }
  .dl { color:var(--accent); text-decoration:none; font-weight:600; }
  .anima { cursor:pointer; color:var(--accent); font-weight:600; user-select:none; }
  .hbtn { height:30px; min-width:0; padding:0 10px; font-size:13px; background:var(--panel); border:1px solid var(--line); }
  #convPanel { position:absolute; top:48px; right:8px; width:min(360px,92vw); max-height:70vh; overflow-y:auto; background:var(--panel); border:1px solid var(--line); border-radius:10px; z-index:20; box-shadow:0 8px 24px #000a; }
  .convHd { padding:10px 12px; font-weight:600; border-bottom:1px solid var(--line); font-size:13px; color:var(--muted); }
  .convItem { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--line); cursor:pointer; }
  .convItem:hover { background:var(--bg); }
  .convItem .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
  .convItem .m { color:var(--muted); font-size:11px; }
  .convItem .del { cursor:pointer; color:var(--no); padding:0 4px; }
  footer { border-top:1px solid var(--line); padding:12px 16px; padding-bottom:max(12px,env(safe-area-inset-bottom)); }
  .row { display:flex; gap:8px; align-items:flex-end; }
  textarea { flex:1; resize:none; background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:10px; padding:10px 12px; font-size:16px; line-height:1.4; min-height:44px; max-height:200px; width:100%; }
  button { background:var(--accent); color:#fff; border:0; border-radius:10px; padding:0 16px; height:44px; min-width:64px; font-weight:600; font-size:15px; cursor:pointer; touch-action:manipulation; }
  button:disabled { opacity:.5; }
  #genBtn.stop { background:#dc2626; }
  .params { display:flex; flex-wrap:wrap; gap:8px 12px; margin-top:8px; color:var(--muted); font-size:12px; align-items:center; }
  .params label { display:flex; align-items:center; gap:4px; }
  .params input, .params select { background:var(--panel); color:var(--fg); border:1px solid var(--line); border-radius:6px; padding:5px 6px; font-size:13px; }
  .params input.n { width:62px; } .params input.t { width:170px; }
  .params input.neg, .params textarea.graph { flex:1 1 100%; width:100%; }
  .params textarea.graph { min-height:90px; font-family:ui-monospace,Menlo,monospace; font-size:12px; }
  .modes { display:flex; gap:6px; margin-bottom:8px; }
  .modes button { height:32px; padding:0 12px; background:var(--panel); border:1px solid var(--line); color:var(--muted); font-size:13px; }
  .modes button.active { background:var(--accent); color:#fff; border-color:var(--accent); }
  .hidden { display:none !important; }
  .lchips { display:flex; flex-wrap:wrap; gap:6px; flex:1 1 100%; }
  .lchip { display:flex; align-items:center; gap:5px; background:var(--panel); border:1px solid var(--line); border-radius:14px; padding:3px 6px 3px 10px; font-size:12px; }
  .lchip input { width:50px; }
  .lchip .x { cursor:pointer; color:var(--no); font-weight:700; padding:0 3px; }
  .spin { display:inline-block; width:14px; height:14px; border:2px solid #ffffff40; border-top-color:#fff; border-radius:50%; animation:s .8s linear infinite; }
  @keyframes s { to { transform:rotate(360deg); } }
  @media (max-width:640px){ #log{padding:12px} .msg{max-width:100%} footer{padding:10px 12px;padding-bottom:max(10px,env(safe-area-inset-bottom))} .params input.t,.params input.n{width:48%;flex:1 1 40%} }
</style></head><body>
<header><span class="dot"></span> Studio<span style="flex:1"></span>
  <button id="newBtn" class="hbtn" title="nuova conversazione">➕ Nuova</button>
  <button id="convBtn" class="hbtn" title="conversazioni salvate">💬 Salvate</button>
</header>
<div id="convPanel" class="hidden">
  <div class="convHd">Conversazioni salvate</div>
  <div id="convList"></div>
</div>
<div id="log"></div>
<footer>
  <div class="modes">
    <button data-mode="sdxl" class="active">🖼️ Immagine (SDXL)</button>
    <button data-mode="chroma">📸 Foto reali (Chroma)</button>
    <button data-mode="video">🎬 Video (Wan)</button>
    <button data-mode="custom">⚙️ Grafo custom</button>
  </div>
  <div class="row"><textarea id="prompt" placeholder="Descrivi cosa generare…  (Invio = genera)"></textarea><button id="genBtn">Genera</button></div>
  <div class="params"><input class="neg" id="negative" placeholder="negative prompt" value="lowres, worst quality, low quality, bad anatomy, bad hands, missing fingers, extra digits, text, watermark, signature, jpeg artifacts, blurry" /></div>
  <div class="params" id="sdxlParams">
    <select id="checkpoint" class="t" title="modello (checkpoint)">
      <option value="ponyRealism_V22.safetensors">ponyRealism V22 (foto)</option>
      <option value="NoobAI-XL-Vpred-v1.0.safetensors">NoobAI-XL v-pred (anime, attiva v-pred)</option>
      <option value="NoobAI-XL-v1.1.safetensors">NoobAI-XL v1.1 (anime)</option>
      <option value="ponyDiffusionV6XL_v6StartWithThisOne.safetensors">Pony Diffusion V6 XL</option>
      <option value="Illustrious-XL-v2.0.safetensors">Illustrious XL v2.0</option>
      <option value="waiIllustriousSDXL_v170.safetensors">WAI Illustrious SDXL v1.70</option>
    </select>
    <select id="loraPick" class="t" title="aggiungi un LoRA"><option value="">+ aggiungi LoRA…</option></select>
    <span id="loraList" class="lchips"></span>
    <label>w <input class="n" id="w" type="number" value="1024" /></label>
    <label>h <input class="n" id="h" type="number" value="1024" /></label>
    <label>steps <input class="n" id="steps" type="number" value="30" /></label>
    <label>cfg <input class="n" id="cfg" type="number" value="6" step="0.5" /></label>
    <label>seed <input class="n" id="seed" type="number" value="0" /></label>
    <select id="sampler"><option>euler</option><option>euler_ancestral</option><option selected>dpmpp_2m</option><option>dpmpp_2m_sde</option><option>dpmpp_sde</option><option>dpmpp_3m_sde</option><option>uni_pc</option><option>ddim</option></select>
    <select id="scheduler"><option>normal</option><option selected>karras</option><option>exponential</option><option>sgm_uniform</option><option>simple</option></select>
    <label><input type="checkbox" id="vpred" /> v-pred</label>
    <label title="img2img: parti da una foto (varianti/modifiche)">📷 foto <input id="refimg" type="file" accept="image/*" style="width:120px;font-size:11px" /></label>
    <label title="quanto resta fedele alla foto (alto = più simile alla tua foto)">fedeltà <input class="n" id="fid" type="number" value="0.65" step="0.05" min="0.1" max="0.9" /></label>
    <label title="upscale ×1.5 + rifinitura → più nitido (più lento)"><input type="checkbox" id="hires" /> ✨ Hires</label>
  </div>
  <div class="params hidden" id="chromaParams">
    <span>Chroma · FLUX uncensored · foto realistiche</span>
    <label>w <input class="n" id="cw" type="number" value="1024" /></label>
    <label>h <input class="n" id="ch" type="number" value="1024" /></label>
    <label>steps <input class="n" id="csteps" type="number" value="26" /></label>
    <label title="Chroma usa CFG reale">cfg <input class="n" id="ccfg" type="number" value="5" step="0.5" /></label>
    <label>seed <input class="n" id="cseed" type="number" value="0" /></label>
    <label title="img2img: parti da una foto">📷 foto <input id="crefimg" type="file" accept="image/*" style="width:120px;font-size:11px" /></label>
    <label title="quanto resta fedele alla foto (alto = più simile)">fedeltà <input class="n" id="cfid" type="number" value="0.65" step="0.05" min="0.1" max="0.9" /></label>
  </div>
  <div class="params hidden" id="videoParams">
    <span>Wan 2.2 14B · video</span>
    <label>w <input class="n" id="vw" type="number" value="832" /></label>
    <label>h <input class="n" id="vh" type="number" value="480" /></label>
    <label title="durata in secondi (max 5 per clip; per 10-15s usa 'Estendi')">durata(s) <input class="n" id="vdur" type="number" value="3" min="1" max="5" step="0.5" /></label>
    <label>fps <input class="n" id="vfps" type="number" value="16" /></label>
    <label title="rallenta il MOVIMENTO con interpolazione RIFE (fluido, no scatti). Aumenta i frame → render più lungo">velocità <select class="n" id="vslowmo"><option value="1">normale</option><option value="2">lento 0.5×</option><option value="3">molto lento 0.33×</option><option value="4">ultra 0.25×</option></select></label>
    <label>steps <input class="n" id="vsteps" type="number" value="30" /></label>
    <label>cfg <input class="n" id="vcfg" type="number" value="5" step="0.5" /></label>
    <label>seed <input class="n" id="vseed" type="number" value="0" /></label>
    <label title="image→video: anima una foto (i2v). Vuoto = text→video">📷 foto <input id="vrefimg" type="file" accept="image/*" style="width:120px;font-size:11px" /></label>
    <label title="⚡ Lightning 4-step: ~5-8× più veloce (CFG 1, step 4). Qualità leggermente inferiore."><input type="checkbox" id="vturbo" checked /> ⚡ Turbo</label>
    <span style="display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center">LoRA:
      <label title="rende il video disegnato/anime"><input type="checkbox" class="vlora" value="animeStyle" /> anime</label>
      <label title="sblocca NSFW in Wan"><input type="checkbox" class="vlora" value="generalNSFW" /> NSFW</label>
      <label title="converte l'input in stile anime (solo i2v)"><input type="checkbox" class="vlora" value="switchToAnime" /> →anime</label>
      <label title="estetica anime vintage anni '90"><input type="checkbox" class="vlora" value="retro90s" /> retro90s</label>
      <label title="forza dei LoRA (0-2)">peso <input class="n" id="vloraw" type="number" value="0.8" step="0.05" min="0" max="2" style="width:54px" /></label>
    </span>
    <span style="display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center">
      <label title="continua un mp4 che carichi: parte dall'ultimo frame (i2v), riscalato a w×h">🎞 estendi mp4 <input id="vextsrc" type="file" accept="video/*" style="width:130px;font-size:11px" /></label>
      <button id="vextBtn" type="button" title="continua il video caricato dall'ultimo frame (LoRA + Turbo del pannello)">↔ Estendi caricato</button>
    </span>
  </div>
  <div class="params hidden" id="customParams">
    <textarea class="graph" id="graphJson" placeholder='Grafo ComfyUI (API format). Segnaposto {{prompt}} {{negative}} {{seed}}.'></textarea>
    <label>timeout(s) <input class="n" id="timeout" type="number" value="300" /></label>
  </div>
</footer>
<script>
const $=(i)=>document.getElementById(i); let MODE='sdxl';
// fitToModel: UNICA fonte (modulo fit-dims.ts) iniettata qui — preserva il
// formato del file caricato così i campi w/h si tarano da soli (no foto tagliate).
const fitToModel = ${fitToModel.toString()};
function addLora(name){const d=document.createElement('span');d.className='lchip';d.dataset.name=name;
  d.innerHTML='<span></span><input type="number" value="0.8" step="0.05" min="-3" max="3"/><span class="x">×</span>';
  d.firstChild.textContent=nice(name);d.querySelector('.x').onclick=()=>d.remove();$('loraList').appendChild(d);}
function collectLoras(){return [...$('loraList').children].map(c=>{const w=parseFloat(c.querySelector('input').value)||1;return{name:c.dataset.name,strengthModel:w,strengthClip:w};});}
function add(c,h){const d=document.createElement('div');d.className='msg '+c;d.innerHTML=h;$('log').appendChild(d);$('log').scrollTop=$('log').scrollHeight;return d;}
function esc(s){return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));}
function card(d,p){const t=d.kind==='video'?'<video src="'+d.url+'" controls loop></video>':'<img src="'+d.url+'" />';
  const animaBtn=d.kind!=='video'?'<span class="anima" data-url="'+d.url+'" title="anima questa foto (i2v)">🎬 Anima</span>':'';
  const extendBtn=(d.kind==='video'&&d.id)?'<span class="extend" data-id="'+d.id+'" title="estendi il video: continua dall\\'ultimo frame (LoRA + Turbo del pannello Video)">↔ Estendi</span>':'';
  return t+'<div class="cap"><span class="vote up" data-id="'+(d.id||'')+'" data-v="up">👍</span><span class="vote down" data-id="'+(d.id||'')+'" data-v="down">👎</span>'+animaBtn+extendBtn+'<a class="dl" href="'+d.url+'" download>⬇ scarica</a><span>seed '+(d.seed||'')+'</span><span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(p)+'</span></div>';}
document.querySelectorAll('.modes button').forEach(b=>b.onclick=()=>{MODE=b.dataset.mode;document.querySelectorAll('.modes button').forEach(x=>x.classList.toggle('active',x===b));$('sdxlParams').classList.toggle('hidden',MODE!=='sdxl');$('chromaParams').classList.toggle('hidden',MODE!=='chroma');$('videoParams').classList.toggle('hidden',MODE!=='video');$('customParams').classList.toggle('hidden',MODE!=='custom');});
// Chroma (FLUX uncensored) — foto realistiche, CFG reale + negative. VERIFICATO E2E.
const CHROMA={unet:{class_type:"UNETLoader",inputs:{unet_name:"chroma-unlocked-v50.safetensors",weight_dtype:"default"}},clip:{class_type:"CLIPLoader",inputs:{clip_name:"t5xxl_fp16.safetensors",type:"chroma"}},vae:{class_type:"VAELoader",inputs:{vae_name:"ae.safetensors"}},pos:{class_type:"CLIPTextEncode",inputs:{text:"{{prompt}}",clip:["clip",0]}},neg:{class_type:"CLIPTextEncode",inputs:{text:"{{negative}}",clip:["clip",0]}},latent:{class_type:"EmptySD3LatentImage",inputs:{width:"{{width}}",height:"{{height}}",batch_size:1}},ks:{class_type:"KSampler",inputs:{seed:"{{seed}}",steps:"{{steps}}",cfg:"{{cfg}}",sampler_name:"euler",scheduler:"simple",denoise:1.0,model:["unet",0],positive:["pos",0],negative:["neg",0],latent_image:["latent",0]}},decode:{class_type:"VAEDecode",inputs:{samples:["ks",0],vae:["vae",0]}},save:{class_type:"SaveImage",inputs:{filename_prefix:"genstudio",images:["decode",0]}}};
// Chroma img2img: parte da una foto ({{start_image}} caricata dal server).
const CHROMA_I2I={unet:{class_type:"UNETLoader",inputs:{unet_name:"chroma-unlocked-v50.safetensors",weight_dtype:"default"}},clip:{class_type:"CLIPLoader",inputs:{clip_name:"t5xxl_fp16.safetensors",type:"chroma"}},vae:{class_type:"VAELoader",inputs:{vae_name:"ae.safetensors"}},img:{class_type:"LoadImage",inputs:{image:"{{start_image}}"}},enc:{class_type:"VAEEncode",inputs:{pixels:["img",0],vae:["vae",0]}},pos:{class_type:"CLIPTextEncode",inputs:{text:"{{prompt}}",clip:["clip",0]}},neg:{class_type:"CLIPTextEncode",inputs:{text:"{{negative}}",clip:["clip",0]}},ks:{class_type:"KSampler",inputs:{seed:"{{seed}}",steps:"{{steps}}",cfg:"{{cfg}}",sampler_name:"euler",scheduler:"simple",denoise:"{{denoise}}",model:["unet",0],positive:["pos",0],negative:["neg",0],latent_image:["enc",0]}},decode:{class_type:"VAEDecode",inputs:{samples:["ks",0],vae:["vae",0]}},save:{class_type:"SaveImage",inputs:{filename_prefix:"genstudio",images:["decode",0]}}};
// NoobAI v-pred richiede la modalità v-prediction: la attivo da solo quando lo selezioni.
$('checkpoint').onchange=()=>{$('vpred').checked=/vpred|v-pred/i.test($('checkpoint').value);};
// Etichetta leggibile: toglie .safetensors e tutto dopo "__" (i LoRA hanno nome lungo).
function nice(f){const b=f.replace(/\\.safetensors$/i,'');const i=b.indexOf('__');return i>0?b.slice(0,i):b;}
// Popola i menù coi file reali su ComfyUI (fail-soft: se spento restano i default).
fetch('/studio/models').then(r=>r.json()).then(d=>{
  if(!d||!d.ok)return;
  if(d.checkpoints&&d.checkpoints.length){$('checkpoint').innerHTML=d.checkpoints.map(c=>'<option value="'+c+'">'+nice(c)+'</option>').join('');}
  if(d.loras&&d.loras.length){$('loraPick').innerHTML='<option value="">+ aggiungi LoRA…</option>'+d.loras.map(l=>'<option value="'+l+'">'+nice(l)+'</option>').join('');}
}).catch(()=>{});
$('loraPick').onchange=()=>{const v=$('loraPick').value;if(v)addLora(v);$('loraPick').value='';};
// Lettori foto → base64 (img2img e i2v).
let refB64=null, vrefB64=null, crefB64=null, vextB64=null;
// Dimensioni naturali dei file caricati per il video (i2v / extend) → mandate al
// server che tara le proporzioni; null finché non si carica nulla.
let vrefDims=null, vextDims=null;
function readImg(input,set){input.onchange=()=>{const f=input.files[0];if(!f){set(null);return;}const r=new FileReader();r.onload=()=>set(r.result);r.readAsDataURL(f);};}
// Applica il fit ai campi w/h del pannello video (anteprima; il server è autoritativo).
function applyVideoFit(d){if(!d)return;const fit=fitToModel(d.w,d.h);$('vw').value=fit.width;$('vh').value=fit.height;}
// Foto i2v: legge naturalWidth/Height → memorizza + auto-tara i form.
function readImgSized(input,setB64,setDims){input.onchange=()=>{const f=input.files[0];if(!f){setB64(null);setDims(null);return;}const r=new FileReader();r.onload=()=>{setB64(r.result);const img=new Image();img.onload=()=>{const d={w:img.naturalWidth,h:img.naturalHeight};setDims(d);applyVideoFit(d);};img.src=r.result;};r.readAsDataURL(f);};}
// Video da estendere: legge videoWidth/Height dai metadata → memorizza + auto-tara.
function readVideoSized(input,setB64,setDims){input.onchange=()=>{const f=input.files[0];if(!f){setB64(null);setDims(null);return;}const r=new FileReader();r.onload=()=>{setB64(r.result);const v=document.createElement('video');v.preload='metadata';v.onloadedmetadata=()=>{const d={w:v.videoWidth,h:v.videoHeight};setDims(d);applyVideoFit(d);};v.src=r.result;};r.readAsDataURL(f);};}
readImg($('refimg'),v=>refB64=v); readImgSized($('vrefimg'),v=>vrefB64=v,d=>vrefDims=d); readImg($('crefimg'),v=>crefB64=v); readVideoSized($('vextsrc'),v=>vextB64=v,d=>vextDims=d);
// durata video (s) → numero frame, snap a 4n+1 (richiesto da Wan)
function vlen(){const dur=Math.min(5,+$('vdur').value||3);const fps=+$('vfps').value||24;const n=Math.round(dur*fps);return Math.max(5,Math.min(121,Math.round((n-1)/4)*4+1));}
// Stato del job corrente (per il tasto Stop). Single-user → uno alla volta.
let curJob=null,curStop=false,curW=null;
function btnGenerate(){const g=$('genBtn');g.textContent='Genera';g.disabled=false;g.classList.remove('stop');g.onclick=gen;}
function btnStop(){const g=$('genBtn');g.textContent='⏹ Stop';g.disabled=false;g.classList.add('stop');g.onclick=stopGen;}
// Ferma la generazione in corso/in coda → interrompe ComfyUI e libera la GPU.
async function stopGen(){if(!curJob)return;curStop=true;const j=curJob;curJob=null;$('genBtn').disabled=true;
  if(curW)curW.innerHTML='<span class="cap">⏹ interrotto</span>';
  try{await fetch('/studio/cancel/'+encodeURIComponent(j),{method:'POST'});}catch(e){/* best-effort */}
  btnGenerate();}
// Lancia un job e fa il polling fino al risultato (riutilizzato da gen, anima, estendi).
async function runJob(b,label,url){
  // UNA generazione alla volta: gen/anima/estendi mentre un job è in corso
  // accodavano un secondo job e il tasto ⏹ Stop (che traccia un solo job) spariva.
  if(curJob){add('ai','<span class="cap">⏳ Una generazione è già in corso — premi ⏹ Stop o aspetta che finisca prima di avviarne un\\'altra.</span>');return;}
  curStop=false;$('genBtn').disabled=true;
  const w=add('ai','<span class="spin"></span> genero… (i video richiedono minuti — puoi premere ⏹ Stop)');curW=w;
  const done=(html)=>{w.innerHTML=html;$('log').scrollTop=$('log').scrollHeight;curJob=null;curW=null;btnGenerate();};
  let d;
  try{const r=await fetch(url||'/studio/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});
    const ct=r.headers.get('content-type')||'';if(!ct.includes('json')){done('<span class="cap">⚠ errore proxy (riprova)</span>');return;}
    d=await r.json();if(!r.ok||!d.ok){done('<span class="cap">⚠ '+esc(d.error||'errore')+'</span>');return;}
  }catch(e){done('<span class="cap">⚠ rete: '+esc(e)+'</span>');return;}
  const jobId=d.jobId;curJob=jobId;btnStop();let tries=0;
  const poll=async()=>{
    if(curStop)return; // stop premuto → il messaggio l'ha già messo stopGen
    try{const sr=await fetch('/studio/status/'+encodeURIComponent(jobId));
      const ct=sr.headers.get('content-type')||'';if(!ct.includes('json')){if(++tries>1200)return done('<span class="cap">⚠ timeout</span>');return setTimeout(poll,3000);}
      const sd=await sr.json();
      if(curStop)return;
      if(sd.status==='done'){done(card({id:sd.id,kind:sd.kind,seed:d.seed,url:sd.url},label));return;}
      if(sd.status==='error'||sd.ok===false){done('<span class="cap">⚠ '+esc(sd.error||'errore')+'</span>');return;}
    }catch(e){/* rete transitoria → continua */}
    if(curStop)return;
    if(++tries>1200){done('<span class="cap">⚠ timeout (oltre 1h)</span>');return;}
    setTimeout(poll,3000);
  };
  poll();
}
function gen(){const p=$('prompt').value.trim();if((MODE==='sdxl'||MODE==='chroma')&&!p)return;if(p)add('me',esc(p));$('prompt').value='';let b;
  if(MODE==='chroma'){const cs=(+$('cseed').value)||Math.floor(Math.random()*2000000000);const ci2i=!!crefB64;
    b={mode:'custom',prompt:p,negative:$('negative').value,seed:cs,graphJson:JSON.stringify(ci2i?CHROMA_I2I:CHROMA),
       variables:{prompt:p,negative:$('negative').value,seed:String(cs),width:String(+$('cw').value),height:String(+$('ch').value),steps:String(+$('csteps').value),cfg:String(+$('ccfg').value),denoise:String(Math.round((1-(+$('cfid').value))*100)/100)},timeout_s:400};
    if(ci2i)b.initImageB64=crefB64;}
  else if(MODE==='video'){const vs=(+$('vseed').value)||Math.floor(Math.random()*2000000000);const useI2V=!!vrefB64;
    b={prompt:p,negative:$('negative').value,seed:vs,video:videoSpec(useI2V?'i2v':'t2v')};
    if(useI2V)b.initImageB64=vrefB64;}
  else if(MODE==='custom'){b={mode:'custom',prompt:p,negative:$('negative').value,graphJson:$('graphJson').value,variables:{prompt:p,negative:$('negative').value,seed:String(+$('seed').value||0)},timeout_s:+$('timeout').value||300};}
  else{b={mode:'sdxl',prompt:p,negative:$('negative').value,checkpoint:$('checkpoint').value.trim(),width:+$('w').value,height:+$('h').value,steps:+$('steps').value,cfg:+$('cfg').value,sampler:$('sampler').value,scheduler:$('scheduler').value,seed:+$('seed').value,sampling:$('vpred').checked?'v_prediction':'eps',loras:collectLoras(),hires:$('hires').checked};
    if(refB64){b.initImageB64=refB64;b.denoise=Math.round((1-(+$('fid').value))*100)/100;}}
  b.conversationId=convId;runJob(b,p);}
// Spec video Wan inviata al server (che costruisce il grafo con catena LoRA + turbo).
function collectVideoLoras(){const w=Math.max(0,Math.min(2,(+$('vloraw').value)||0.8));return [...document.querySelectorAll('.vlora:checked')].map(c=>({name:c.value,weight:w}));}
function videoSpec(kind){return {kind:kind,width:+$('vw').value,height:+$('vh').value,length:vlen(),fps:+$('vfps').value,steps:+$('vsteps').value,cfg:+$('vcfg').value,turbo:$('vturbo').checked,slowmo:+$('vslowmo').value||1,srcWidth:vrefDims?vrefDims.w:undefined,srcHeight:vrefDims?vrefDims.h:undefined,loras:collectVideoLoras()};}
// Anima una foto già generata: scarica il media → i2v Wan (parametri + LoRA + turbo del pannello Video).
async function anima(url){
  try{const resp=await fetch(url);const blob=await resp.blob();
    const b64=await new Promise(r=>{const fr=new FileReader();fr.onload=()=>r(fr.result);fr.readAsDataURL(blob);});
    const vs=Math.floor(Math.random()*2000000000);
    const b={prompt:'',negative:$('negative').value,seed:vs,initImageB64:b64,video:videoSpec('i2v'),conversationId:convId};
    add('me','🎬 anima questa foto');runJob(b,'animazione');
  }catch(e){add('ai','<span class="cap">⚠ '+esc(e)+'</span>');}
}
// Estendi un video esistente: continua dall'ultimo frame (LoRA + turbo del pannello Video).
// Popup per descrivere la continuazione (vuoto = stesso tema del video sorgente).
function extend(id){if(!id)return;
  const np=prompt('Cosa succede nella continuazione? (lascia vuoto = stesso tema del video)');
  if(np===null)return; // annullato
  const d=np.trim();
  const b={turbo:$('vturbo').checked,length:vlen(),slowmo:+$('vslowmo').value||1,loras:collectVideoLoras(),conversationId:convId};
  if(d)b.prompt=d;
  add('me','↔ estendi video'+(d?(': '+esc(d)):''));runJob(b,'estensione','/studio/extend/'+encodeURIComponent(id));}
// Estendi un mp4 CARICATO dall'utente: continua dall'ultimo frame (riscalato a w×h del pannello).
function extendUpload(){
  if(!vextB64){add('ai','<span class="cap">⚠ scegli prima un mp4 da continuare (campo "estendi mp4")</span>');return;}
  const np=prompt('Cosa succede nella continuazione del video caricato? (vuoto = nessuna guida)');
  if(np===null)return;
  const d=np.trim();
  const b={videoB64:vextB64,turbo:$('vturbo').checked,length:vlen(),slowmo:+$('vslowmo').value||1,width:+$('vw').value,height:+$('vh').value,srcWidth:vextDims?vextDims.w:undefined,srcHeight:vextDims?vextDims.h:undefined,loras:collectVideoLoras(),conversationId:convId};
  if(d)b.prompt=d;
  add('me','↔ estendi mp4 caricato'+(d?(': '+esc(d)):''));runJob(b,'estensione','/studio/extend-upload');}
// ── Conversazioni: salva (automatico via conversationId) / riprendi / cancella ──
function newId(){return 'c-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,8);}
let convId=newId();
$('newBtn').onclick=()=>{convId=newId();$('log').innerHTML='';$('convPanel').classList.add('hidden');};
$('convBtn').onclick=()=>{const p=$('convPanel');if(p.classList.contains('hidden')){loadConvs();p.classList.remove('hidden');}else{p.classList.add('hidden');}};
async function loadConvs(){try{const r=await fetch('/studio/conversations');const d=await r.json();
  if(!d.ok){$('convList').innerHTML='<div class="convItem m">errore</div>';return;}
  if(!d.items.length){$('convList').innerHTML='<div class="convItem m">(nessuna ancora)</div>';return;}
  $('convList').innerHTML=d.items.map(c=>'<div class="convItem" data-id="'+c.id+'"><span class="t">'+esc(c.title)+'</span><span class="m">'+c.count+'</span><span class="del" data-id="'+c.id+'" title="cancella">🗑</span></div>').join('');
}catch(e){$('convList').innerHTML='<div class="convItem m">rete</div>';}}
$('convList').addEventListener('click',async e=>{
  const del=e.target.closest('.del');if(del){e.stopPropagation();if(!confirm('Cancellare questa conversazione?'))return;await fetch('/studio/conversation/'+encodeURIComponent(del.dataset.id),{method:'DELETE'});loadConvs();return;}
  const it=e.target.closest('.convItem');if(it&&it.dataset.id)openConv(it.dataset.id);});
async function openConv(id){try{const r=await fetch('/studio/conversation/'+encodeURIComponent(id));const d=await r.json();if(!d.ok)return;
  convId=id;$('log').innerHTML='';$('convPanel').classList.add('hidden');
  for(const it of d.items){if(it.prompt)add('me',esc(it.prompt));add('ai',card({id:it.id,kind:it.kind,url:it.url,seed:''},it.prompt));}
  $('log').scrollTop=$('log').scrollHeight;
}catch(e){}}
$('genBtn').onclick=gen;$('vextBtn').onclick=extendUpload;$('prompt').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();gen();}});
$('log').addEventListener('click',async e=>{
  const an=e.target.closest('.anima');if(an){anima(an.dataset.url);return;}
  const ex=e.target.closest('.extend');if(ex){extend(ex.dataset.id);return;}
  const v=e.target.closest('.vote');if(!v||!v.dataset.id)return;const want=v.dataset.v,on=v.classList.contains('on-'+want),rating=on?null:want;
  await fetch('/studio/rate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:v.dataset.id,rating})});
  v.parentElement.querySelectorAll('.vote').forEach(x=>x.classList.remove('on-up','on-down'));if(rating)v.classList.add('on-'+rating);});
</script></body></html>`;
