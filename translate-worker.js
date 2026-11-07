/* Velvet Scroll: translating books on this device (experimental).
   Runs Mozilla's Bergamot translation engine (the engine behind Firefox Translations, MPL 2.0) as WebAssembly in a
   module worker, with Mozilla's translation models. Nothing from the book leaves the device: the engine and the
   models are downloaded once (and kept in the browser's cache), then everything runs here.

   Messages in:  {id, op:'init', engineUrl}
                 {id, op:'load', key, src, trg, base, files:[{kind, name, sha256, size}]}
                 {id, op:'translate', key, texts:[html…]}
                 {id, op:'remove'}   (deletes the downloaded files)
   Messages out: {id, r} when done, {id, err} on failure, {id, progress:{loaded, total}} while downloading. */
import { loadBergamot } from './lib/bergamot/bergamot-translator.mjs';

const CACHE = 'vs-translate';
const ALIGN = {model:256, lex:64, vocab:64, srcVocab:64, trgVocab:64};
// Firefox's own decoder settings, with a smaller mini-batch (less memory, about as fast for paragraphs)
const CONFIG = {'beam-size':'1', normalize:'1.0', 'word-penalty':'0', 'max-length-break':'128', 'mini-batch-words':'512',
  workspace:'128', 'max-length-factor':'2.0', 'skip-cost':'true', 'cpu-threads':'0', quiet:'true', 'quiet-translation':'true',
  alignment:'soft', 'gemm-precision':'int8shiftAlphaAll'};
let mod = null, svc = null; const models = new Map();

async function cached(url, version, onProgress, gz, sha256){
  let cache = null; try{ cache = await caches.open(CACHE); }catch(e){}
  const key = url + '?v=' + version, hit = cache && await cache.match(key);
  if(hit) return new Uint8Array(await hit.arrayBuffer());
  const res = await fetch(url, {cache:'no-store'});
  if(!res.ok) throw new Error('download ' + res.status);
  const total = +res.headers.get('content-length') || 0, rd = res.body.getReader(), parts = []; let got = 0;
  for(;;){ const {done, value} = await rd.read(); if(done) break; parts.push(value); got += value.length; onProgress && onProgress(got, total); }
  let bytes = new Uint8Array(got), o = 0; for(const p of parts){ bytes.set(p, o); o += p.length; }
  if(gz) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if(sha256){
    const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
    if(h !== sha256) throw new Error('corrupt');
  }
  try{ cache && await cache.put(key, new Response(bytes)); }catch(e){}
  return bytes;
}

const ops = {
  async init({engineUrl}, progress){
    if(mod) return true;
    const wasmBinary = (await cached(engineUrl, 'v0.6.0+df4ab487', progress)).buffer;
    mod = await new Promise((resolve, reject) => {
      const m = loadBergamot({INITIAL_MEMORY:41943040, print(){}, printErr(){}, wasmBinary,
        onAbort: r => reject(new Error('engine: ' + r)), onRuntimeInitialized: async () => { await 0; resolve(m); }});
    });
    svc = new mod.BlockingService({cacheSize:0});
    return true;
  },
  async load({key, src, trg, base, files}, progress){
    if(models.has(key)) return true;
    const total = files.reduce((n, f) => n + (f.gzSize || 0), 0); let before = 0; const bytes = {};
    for(const f of files){
      bytes[f.kind] = await cached(base + f.name + '.gz', f.sha256, (g) => progress(before + g, total), true, f.sha256);
      before += f.gzSize || 0;
    }
    const al = {};
    for(const [k, b] of Object.entries(bytes)){ const m = new mod.AlignedMemory(b.byteLength, ALIGN[k]); m.getByteArrayView().set(new Int8Array(b.buffer, b.byteOffset, b.byteLength)); al[k] = m; }
    const vocabs = new mod.AlignedMemoryList(); vocabs.push_back(al.vocab);
    const yaml = Object.entries(CONFIG).map(([k, v]) => k + ': ' + v).join('\n') + '\n';
    models.set(key, new mod.TranslationModel(src, trg, yaml, al.model, al.lex || null, vocabs, null));
    return true;
  },
  translate({key, texts}){
    const model = models.get(key); if(!model) throw new Error('not loaded');
    const msgs = new mod.VectorString(), opts = new mod.VectorResponseOptions();
    for(const t of texts){ msgs.push_back(t); opts.push_back({qualityScores:false, alignment:true, html:true}); }
    let res;
    try{ res = svc.translate(model, msgs, opts); const out = []; for(let i = 0; i < res.size(); i++) out.push(res.get(i).getTranslatedText()); return out; }
    finally{ msgs.delete(); opts.delete(); res && res.delete(); }
  },
  async remove(){ for(const m of models.values()) m.delete(); models.clear(); try{ await caches.delete(CACHE); }catch(e){} return true; }
};

let chain = Promise.resolve();
onmessage = e => {
  const {id, op, ...a} = e.data;
  let last = 0;
  const progress = (loaded, total) => { const now = Date.now(); if(now - last > 150){ last = now; postMessage({id, progress:{loaded, total}}); } };
  // one job at a time: the engine isn't re-entrant
  chain = chain.then(async () => {
    try{ postMessage({id, r: await ops[op](a, progress)}); }
    catch(err){ postMessage({id, err: String(err && err.message || err)}); }
  });
};
