/* Velvet Scroll: natural voices (Piper), run in a worker so reading and scrolling stay smooth.
   Text is turned into speech sounds by eSpeak NG (piper-phonemize, GPL-3.0), then into audio by a Piper voice model
   with ONNX Runtime Web. The page says where the code is (packaged with the extension, or jsDelivr for the website).
   Voice models and eSpeak NG's dictionary data are downloaded once and kept in the browser's cache. */
let P = null, ORT = null, phonData = null, phon = null, phonCalls = 0, phonWasm = null, session = null, config = null, voiceId = '', pending = null;
const send = (m, t) => postMessage(m, t || []);
const CACHE = 'velvet-voices';

// a second place to keep downloads where the Cache API isn't available (some browsers and private windows)
function idb(){ return new Promise((ok, no) => { const r = indexedDB.open(CACHE, 1); r.onupgradeneeded = () => r.result.createObjectStore('files'); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); }); }
async function idbDo(mode, fn){ const db = await idb(); try{ return await new Promise((ok, no) => { const q = fn(db.transaction('files', mode).objectStore('files')); q.onsuccess = () => ok(q.result); q.onerror = () => no(q.error); }); } finally{ db.close(); } }

// download with progress, keeping a copy in the browser's cache
async function fetchCached(url, onBytes){
  let cache = null, useIdb = false;
  try{ cache = await caches.open(CACHE); const hit = await cache.match(url); if(hit){ const b = await hit.arrayBuffer(); onBytes(b.byteLength, b.byteLength); return b; } }catch(e){ cache = null; }
  if(!cache && typeof indexedDB === 'object'){ useIdb = true;
    try{ const b = await idbDo('readonly', st => st.get(url)); if(b){ onBytes(b.byteLength, b.byteLength); return b; } }catch(e){ useIdb = false; } }
  const r = await fetch(url); if(!r.ok) throw new Error('download failed (' + r.status + ')');
  const total = +r.headers.get('content-length') || 0, reader = r.body.getReader(), parts = []; let got = 0;
  for(;;){ const {done, value} = await reader.read(); if(done) break; parts.push(value); got += value.length; onBytes(got, total); }
  const blob = new Blob(parts);
  const buf = await blob.arrayBuffer();
  if(cache){ try{ await cache.put(url, new Response(blob)); }catch(e){} }
  else if(useIdb){ try{ await idbDo('readwrite', st => st.put(buf, url)); }catch(e){} }
  return buf;
}

async function engine(){
  if(ORT) return;
  importScripts(P.ortJs, P.phonJs);
  ORT = self.ort; ORT.env.wasm.wasmPaths = P.ortBase; ORT.env.wasm.numThreads = 1;
}
// eSpeak NG keeps a little memory from every sentence and its memory can't grow, so after a couple of hundred sentences
// it fails ("memory access out of bounds"). A fresh copy is started every 100 sentences, or straight away if one fails.
const PHON_FRESH_EVERY = 100;
async function phonemizer(fresh){
  if(phon && !fresh && phonCalls < PHON_FRESH_EVERY) return phon;
  phon = null; phonCalls = 0;
  if(!phonWasm){ const r = await fetch(P.phonWasm); if(!r.ok) throw new Error('download failed (' + r.status + ')'); phonWasm = await WebAssembly.compile(await r.arrayBuffer()); }
  phon = await self.createPiperPhonemize({
    // the compiled engine is kept, so a fresh copy only has to start up (a fraction of a second)
    instantiateWasm: (imports, done) => { WebAssembly.instantiate(phonWasm, imports).then(inst => done(inst, phonWasm)); return {}; },
    print: line => { const p = pending; pending = null; if(p) try{ p.ok(JSON.parse(line).phoneme_ids); }catch(e){ p.no(e); } },
    printErr: () => {},
    locateFile: f => f.endsWith('.wasm') ? P.phonWasm : f,
    getPreloadedPackage: () => phonData
  });
  return phon;
}
async function phonemes(text){
  try{ await phonemizer(); return await phonemesOnce(text); }
  catch(e){ await phonemizer(true); return phonemesOnce(text); }
}
function phonemesOnce(text){
  phonCalls++;
  return new Promise((ok, no) => {
    pending = {ok, no};
    try{ phon.callMain(['-l', config.espeak.voice, '--input', JSON.stringify([{text}]), '--espeak_data', '/espeak-ng-data']); }
    catch(e){ pending = null; no(e); return; }
    if(pending){ pending = null; no(new Error('no phonemes')); }
  });
}

async function load(d){
  P = d.paths; await engine();
  // what still needs downloading: the eSpeak NG data (once) and this voice
  const parts = [];
  if(!phonData) parts.push({url:P.phonData, size:18077249, set:b => { phonData = b; }});
  if(voiceId !== d.voice.id) parts.push({url:d.voice.json, size:6000, set:b => { config = JSON.parse(new TextDecoder().decode(b)); }},
                                         {url:d.voice.onnx, size:d.voice.size, set:b => { d._model = b; }});
  const got = parts.map(() => 0), want = parts.map(p => p.size);
  const tick = () => send({type:'progress', loaded:got.reduce((a, b) => a + b, 0), total:want.reduce((a, b) => a + b, 0)});
  await Promise.all(parts.map((p, i) => fetchCached(p.url, (n, t) => { got[i] = n; if(t) want[i] = t; tick(); }).then(p.set)));
  await phonemizer();
  if(d._model){
    if(session){ try{ await session.release(); }catch(e){} session = null; }
    session = await ORT.InferenceSession.create(new Uint8Array(d._model), {executionProviders:['wasm']});
    voiceId = d.voice.id;
  }
}

async function generate(text, speed){
  let ids = null;
  try{ ids = await phonemes(text); }catch(e){ if(!/no phonemes/.test(e.message)) throw e; }
  // nothing to say (a row of asterisks, a lone symbol): a short pause instead
  if(!ids || ids.length < 3) return {pcm:new Float32Array(Math.round((config.audio.sample_rate || 22050) * 0.25)), rate:config.audio.sample_rate || 22050};
  const inf = config.inference || {}, feeds = {
    input: new ORT.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ORT.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ORT.Tensor('float32', Float32Array.from([inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) / speed, inf.noise_w ?? 0.8]), [3])};
  if((config.num_speakers || 1) > 1) feeds.sid = new ORT.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const out = await session.run(feeds), pcm = new Float32Array(out[session.outputNames[0]].data);
  return {pcm, rate:config.audio.sample_rate};
}

let queue = Promise.resolve();   // one job at a time
onmessage = e => {
  const d = e.data;
  queue = queue.then(async () => {
    try{
      if(d.type === 'load'){ await load(d); send({type:'ready'}); }
      else if(d.type === 'gen'){
        const t0 = performance.now(), r = await generate(d.text, Math.min(2, Math.max(0.5, d.speed || 1)));
        send({type:'audio', id:d.id, pcm:r.pcm, rate:r.rate, ms:performance.now() - t0}, [r.pcm.buffer]);
      }
    }catch(err){ send({type:'error', id:d.id, phase:d.type, msg:String(err && err.message || err)}); }
  });
};
