#!/usr/bin/env node
/**
 * crawler.cjs  (Advanced / Seed-Limiter Version)
 *
 * Purpose:
 *   Lightweight breadth-first crawler used in two modes:
 *     1. Stand-alone ?Crawl Only? (GUI crawl form)
 *     2. Auto-Discover (Direct Run Depth) prior to archiving
 *
 * Key Fixes vs. Previous Version:
 *   - MAX_PAGES now controls TOTAL pages actually fetched (visitedOrder length),
 *     not the size of the discovered list.
 *   - urls.txt now contains ONLY the pages actually crawled (up to MAX_PAGES),
 *     in the chronological order they were fetched (not the entire discovered set).
 *   - Discovered-but-not-fetched URLs no longer force the archiver to expand unexpectedly.
 *   - Added seedsForArchive count in final log for clarity.
 *   - Added graceful early exit if external STOP flag file is dropped (optional).
 *
 * Environment Variables (defaults in parentheses):
 *   START_URLS (required)  newline or comma separated list
 *   OUTPUT_DIR (required)  destination directory (urls file placed in OUTPUT_DIR/_crawl)
 *   MAX_PAGES=200          total pages to FETCH (feeds archiver)
 *   MAX_DEPTH=3            BFS depth limit (0 = only the seeds)
 *   SAME_HOST_ONLY=true
 *   INCLUDE_SUBDOMAINS=true
 *   ALLOW_REGEX=           optional allow pattern
 *   DENY_REGEX=            optional deny pattern
 *   KEEP_QUERY_PARAMS=     comma list of query params to keep (others stripped)
 *   STRIP_ALL_QUERIES=false
 *   WAIT_AFTER_LOAD=500    ms wait after domcontentloaded
 *   NAV_TIMEOUT=15000      per navigation
 *   PAGE_TIMEOUT=45000     (not heavily used yet; placeholder for per-page budget)
 *   USER_AGENT= (chromium-like default)
 *
 *   PROXIES_FILE=          optional JSON array like:
 *                          [{ "server":"http://host:port","username":"user","password":"pass"}]
 *   STABLE_SESSION=true
 *   ROTATE_SESSION=false
 *   ROTATE_EVERY=0         rotate proxy/session every N pages (when not stable)
 *
 * Optional STOP MECHANISM (used by GUI stop-run escalation):
 *   If a file named STOP in OUTPUT_DIR/_crawl is created during crawl,
 *   crawler stops as soon as current page finishes.
 *
 * Outputs (in OUTPUT_DIR/_crawl):
 *   urls.txt               (ONLY fetched pages, in visit order; what archiver will use)
 *   discovered-debug.txt   (all normalized URLs ever seen; for diagnostics)
 *   graph.json             simple graph (nodes/edges) of discovered links
 *   report.json            metadata summary
 *
 * Exit Codes:
 *   0 success
 *   2 no pages found
 *   3 configuration error
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright');
const { HttpsProxyAgent } = require('https-proxy-agent');
const https = require('https');

/* ---------------- Utility Helpers ---------------- */
function flag(name, def=false){
  const v = process.env[name];
  if (v == null) return def;
  return ['1','true','yes','on'].includes(v.toLowerCase());
}
function ensureDir(d){ fs.mkdirSync(d,{recursive:true}); }
function sha12(x){ return crypto.createHash('sha1').update(x).digest('hex').slice(0,12); }

const START_URLS_RAW = process.env.START_URLS || '';
const OUTPUT_DIR = process.env.OUTPUT_DIR;
if (!START_URLS_RAW || !OUTPUT_DIR){
  console.error('START_URLS and OUTPUT_DIR required');
  process.exit(3);
}
const START_URLS = [...new Set(START_URLS_RAW.split(/\r?\n|,/).map(s=>s.trim()).filter(Boolean))];
if (!START_URLS.length){
  console.error('No valid START_URLS');
  process.exit(3);
}

const MAX_PAGES         = parseInt(process.env.MAX_PAGES||'200',10);
const MAX_DEPTH         = parseInt(process.env.MAX_DEPTH||'3',10);
const SAME_HOST_ONLY    = flag('SAME_HOST_ONLY', true);
const INCLUDE_SUBDOMAINS= flag('INCLUDE_SUBDOMAINS', true);
const ALLOW_REGEX_STR   = process.env.ALLOW_REGEX || '';
const DENY_REGEX_STR    = process.env.DENY_REGEX || '';
const KEEP_QUERY_PARAMS = (process.env.KEEP_QUERY_PARAMS||'').split(',').map(s=>s.trim()).filter(Boolean);
const STRIP_ALL_QUERIES = flag('STRIP_ALL_QUERIES', false);
// Prefer certain URLs (e.g., product detail pages) by regex; preferred URLs are queued ahead of others
// Additionally allow a CATEGORY_PREFER_REGEX to ensure category/listing pages are crawled before product pages.
const PREFER_REGEX_STR  = process.env.PREFER_REGEX || '';
const CATEGORY_PREFER_REGEX_STR = process.env.CATEGORY_PREFER_REGEX || '';
const WAIT_AFTER_LOAD   = parseInt(process.env.WAIT_AFTER_LOAD||'500',10);
const NAV_TIMEOUT       = parseInt(process.env.NAV_TIMEOUT||'15000',10);
const PAGE_TIMEOUT      = parseInt(process.env.PAGE_TIMEOUT||'45000',10); // (placeholder)
const USER_AGENT = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const PROXIES_FILE  = process.env.PROXIES_FILE || '';
const STABLE_SESSION= flag('STABLE_SESSION', true);
const ROTATE_SESSION= flag('ROTATE_SESSION', false);
const ROTATE_EVERY  = parseInt(process.env.ROTATE_EVERY||'0',10);
// Deterministic / quick-win & full-auto flags
const QUICK_DET_MODE = flag('QUICK_DET_MODE', false); // stable ordering & quotas
const FULL_AUTO_MODE = flag('FULL_AUTO_MODE', false); // invoke structure detection probe
const CATEGORY_PRODUCT_QUOTA = parseInt(process.env.CATEGORY_PRODUCT_QUOTA||'0',10); // per-category cap (quick mode)
const TOTAL_PRODUCT_CAP = parseInt(process.env.TOTAL_PRODUCT_CAP||'0',10); // across all categories/products
const PLAN_PRODUCTS_PER_CATEGORY = parseInt(process.env.PLAN_PRODUCTS_PER_CATEGORY||'10',10);
const PLAN_GLOBAL_PRODUCT_CAP = parseInt(process.env.PLAN_GLOBAL_PRODUCT_CAP||'400',10);
const PLAN_PROBE_CATEGORY_LIMIT = parseInt(process.env.PLAN_PROBE_CATEGORY_LIMIT||'40',10);
const PLAN_TIMEOUT = parseInt(process.env.PLAN_TIMEOUT||'15000',10);
const REUSE_DOMAIN_PROFILE = flag('REUSE_DOMAIN_PROFILE', true);
const FORCE_REBUILD_PLAN = flag('FORCE_REBUILD_PLAN', false);

let structurePlan = null; // loaded lazily inside crawl when FULL_AUTO_MODE

/* Regex compile */
let allowRx=null, denyRx=null;
if (ALLOW_REGEX_STR){
  try { allowRx = new RegExp(ALLOW_REGEX_STR,'i'); } catch(e){ console.error('Invalid ALLOW_REGEX', e.message); }
}
if (DENY_REGEX_STR){
  try { denyRx = new RegExp(DENY_REGEX_STR,'i'); } catch(e){ console.error('Invalid DENY_REGEX', e.message); }
}
let preferRx=null, categoryPreferRx=null;
if (PREFER_REGEX_STR){
  try { preferRx = new RegExp(PREFER_REGEX_STR,'i'); } catch(e){ console.error('Invalid PREFER_REGEX', e.message); }
} else {
  try { preferRx = new RegExp('/[a-z0-9-]*[0-9][a-z0-9-]*\\.html$', 'i'); } catch { preferRx=null; }
}
if (CATEGORY_PREFER_REGEX_STR){
  try { categoryPreferRx = new RegExp(CATEGORY_PREFER_REGEX_STR,'i'); } catch(e){ console.error('Invalid CATEGORY_PREFER_REGEX', e.message); }
} else {
  // Heuristic: catalog or category listing pages often contain '-catalog-' or '-category-' fragments or 'catalog-details'. Adjust as needed.
  try { categoryPreferRx = new RegExp('/(catalog|category)[-a-z0-9]*\\.html$', 'i'); } catch { categoryPreferRx=null; }
}

/* Proxy rotation */
let proxies=[];
if (PROXIES_FILE){
  try {
    proxies = JSON.parse(fs.readFileSync(PROXIES_FILE,'utf8'));
    if(!Array.isArray(proxies)) proxies=[];
  } catch { proxies=[]; }
}
let proxyIndex=0;
function randSession(){ return crypto.randomBytes(4).toString('hex'); }
function nextProxy(pagesDone){
  if(!proxies.length) return null;
  if(!STABLE_SESSION && ROTATE_EVERY>0 && pagesDone>0 && pagesDone % ROTATE_EVERY===0){
    proxyIndex++;
  }
  const base=proxies[proxyIndex % proxies.length];
  let username=base.username||'';
  if(!STABLE_SESSION && ROTATE_SESSION){
    username=username.replace(/(session-)[A-Za-z0-9_-]+/,(_,p)=>p+randSession());
  }
  return { server:base.server, username, password:base.password };
}

/* Normalization */
function normalizeURL(raw, rootHost){
  let u;
  try {
    u = new URL(raw);
  } catch { return null; }
  if (!/^https?:$/i.test(u.protocol)) return null;

  if (SAME_HOST_ONLY){
    const rootLower = rootHost.toLowerCase();
    const hostLower = u.hostname.toLowerCase();
    const same = hostLower === rootLower;
    const sub = INCLUDE_SUBDOMAINS && hostLower.endsWith('.'+rootLower);
    if (!same && !sub) return null;
  }

  u.hash='';
  if (STRIP_ALL_QUERIES){
    u.search='';
  } else if (KEEP_QUERY_PARAMS.length){
    const params=new URLSearchParams(u.search);
    [...params.keys()].forEach(k=>{
      if(!KEEP_QUERY_PARAMS.includes(k)) params.delete(k);
    });
    u.search = params.toString()?('?'+params.toString()):'';
  }

  let final=u.toString();
  try {
    if (u.pathname !== '/' && final.endsWith('/')) final=final.slice(0,-1);
  } catch {}
  if (allowRx && !allowRx.test(final)) return null;
  if (denyRx && denyRx.test(final)) return null;
  return final;
}

/* Browser creation (chromium only for speed; can be extended) */
async function createBrowser(proxyObj){
  const args=['--no-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled'];
  const launch={ headless:true };
  if(proxyObj){
    launch.proxy={ server:proxyObj.server, username:proxyObj.username, password:proxyObj.password };
  }
  launch.args=args;
  return chromium.launch(launch);
}

/* Optional STOP flag file */
function stopFlagPath(outDir){
  return path.join(outDir,'_crawl','STOP');
}
function stopRequested(outDir){
  try { return fs.existsSync(stopFlagPath(outDir)); } catch { return false; }
}

/* Main Crawl */
async function crawl(){
  const crawlDir = path.join(OUTPUT_DIR,'_crawl');
  ensureDir(crawlDir);

  const rootURL=START_URLS[0];
  const rootHost=(()=>{ try { return new URL(rootURL).hostname; } catch { return ''; }})();

  // Load full-auto plan first (synchronous await) so seeding & regex override happens before queue operations
  if(FULL_AUTO_MODE){
    try {
      const { detectStructure } = require('./lib/structure-detect.cjs');
      const domainProfileDir = path.join(OUTPUT_DIR,'..','_profiles');
      ensureDir(domainProfileDir);
      let host=''; try { host=new URL(rootURL).hostname; } catch{}
      const profilePath = path.join(domainProfileDir, host + '.json');
      let cached=null;
      if(REUSE_DOMAIN_PROFILE && fs.existsSync(profilePath) && !FORCE_REBUILD_PLAN){
        try { cached=JSON.parse(fs.readFileSync(profilePath,'utf8')); } catch { cached=null; }
      }
      if(cached){
        structurePlan = cached;
        console.log(`[PLAN_REUSE] host=${host} hash=${cached.hash} cats=${cached.categories?.length||0} products=${cached.productList?.length||0}`);
      } else {
        structurePlan = await detectStructure({
          startUrls: START_URLS,
          outputDir: OUTPUT_DIR,
          probeCategoryLimit: PLAN_PROBE_CATEGORY_LIMIT,
          productsPerCategory: PLAN_PRODUCTS_PER_CATEGORY,
          globalProductCap: PLAN_GLOBAL_PRODUCT_CAP,
          timeoutMs: PLAN_TIMEOUT
        });
        try { fs.writeFileSync(profilePath, JSON.stringify(structurePlan,null,2)); } catch(e){ console.error('profile write fail', e.message); }
      }
      if(structurePlan){
        console.log(`[PLAN_APPLY] cats=${structurePlan.categories.length} products=${structurePlan.productList.length} hash=${structurePlan.hash}`);
        // Override preference regexes if plan generated patterns
        if(structurePlan.categoryRegex){
          try { categoryPreferRx = new RegExp(structurePlan.categoryRegex.replace(/^\//,'').replace(/\/$/,'') ,'i'); } catch(e){ console.error('plan categoryRegex compile failed', e.message); }
        }
        if(structurePlan.productRegex){
          try { preferRx = new RegExp(structurePlan.productRegex.replace(/^\//,'').replace(/\/$/,'') ,'i'); } catch(e){ console.error('plan productRegex compile failed', e.message); }
        }
      }
    } catch(e){
      console.error('[PLAN_APPLY_ERR]', e.message);
    }
  }

  const queue=[];               // BFS queue: {url, depth, type}
  // Helper to enqueue with 3-tier preference: category > product > normal
  function enqueuePreferred(item){
    if (!item || !item.url) return;
    const u=item.url;
    const isCategory = categoryPreferRx ? categoryPreferRx.test(u) : false;
    const isProduct = !isCategory && (preferRx ? preferRx.test(u) : false);
    if (QUICK_DET_MODE){
      // Stable deterministic ordering: maintain buckets, then merge.
      // Simpler implementation: just tag and push; sorting happens before dequeue.
      item.type = isCategory? 'category' : (isProduct? 'product':'normal');
      queue.push(item);
      return;
    }
    if (isCategory){
      // Put at absolute front
      queue.unshift(item);
    } else if (isProduct){
      // Insert after any existing category-priority items but before normal ones.
      let insertAt = 0;
      // find first non-category (since categories may already be at front)
      for(let i=0;i<queue.length;i++){
        const q=queue[i];
        if(!(categoryPreferRx && categoryPreferRx.test(q.url))){
          insertAt = i; break;
        }
        insertAt = i+1; // all front items are categories
      }
      queue.splice(insertAt,0,item);
    } else {
      queue.push(item);
    }
  }
  const seen=new Set();         // all normalized URLs ever seen (discovered)
  const visitedOrder=[];        // order of ACTUAL FETCHES (pages we opened) -> seeds for archiver
  const depths=new Map();       // url -> depth (for graph)
  const edges=[];               // {from,to}

  if(structurePlan){
    const rootNorm = normalizeURL(rootURL, rootHost);
    const added = new Set();
    function addSeed(u, depth, forcedType){
      const n = normalizeURL(u, rootHost); if(!n) return;
      if(!seen.has(n)){
        seen.add(n); depths.set(n,depth);
        enqueuePreferred({ url:n, depth, type:forcedType });
        added.add(n);
      }
    }
    if(rootNorm) addSeed(rootNorm,0,'category');
    (structurePlan.categories||[]).forEach(c=>{ if(c!==rootNorm) addSeed(c,0,'category'); });
    (structurePlan.productList||[]).forEach(p=> addSeed(p,1,'product'));
  } else {
    START_URLS.forEach(u=>{
      const n=normalizeURL(u, rootHost);
      if(n && !seen.has(n)){
        seen.add(n);
        depths.set(n,0);
      	enqueuePreferred({url:n, depth:0});
      }
    });
  }

  let pagesCrawled=0;
  let browser=await createBrowser(nextProxy(0));
  const context=await browser.newContext({
    userAgent:USER_AGENT,
    viewport:{width:1366,height:900},
    locale:'en-US'
  });

  async function processItem(item){
    if (pagesCrawled >= MAX_PAGES) return;
    if (item.depth > MAX_DEPTH) return;
    if (stopRequested(OUTPUT_DIR)) return;

    let page;
    let ok=false;
    let linkCount=0;
    try {
      page=await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      await page.goto(item.url,{ waitUntil:'domcontentloaded' });
      if (WAIT_AFTER_LOAD>0) await page.waitForTimeout(WAIT_AFTER_LOAD);
      // Mark visited
      visitedOrder.push(item.url);
      pagesCrawled++;

      // Extract links only if we can still expand
      if (pagesCrawled < MAX_PAGES && item.depth < MAX_DEPTH){
        const hrefs=await page.$$eval('a[href]', as=>as.map(a=>a.getAttribute('href')));
        for(const raw of hrefs){
          if(!raw) continue;
          let resolved;
            try { resolved=new URL(raw, item.url).toString(); } catch { continue; }
          const norm=normalizeURL(resolved, rootHost);
          if(!norm) continue;
          edges.push({ from:item.url, to:norm });
          if(!seen.has(norm)){
            seen.add(norm);
            const d=item.depth+1;
            depths.set(norm,d);
            // Enqueue only if we still can fetch more pages and depth within limit
            if (d <= MAX_DEPTH && visitedOrder.length < MAX_PAGES){
              // Track origin category for quick deterministic mode if needed
              let typeHint=null;
              if(QUICK_DET_MODE && !structurePlan){
                const isCat = categoryPreferRx && categoryPreferRx.test(item.url);
                const isProd = preferRx && preferRx.test(norm) && !(categoryPreferRx && categoryPreferRx.test(norm));
                if(isProd && isCat){
                  enqueuePreferred({ url:norm, depth:d, originCategory:item.url });
                  continue;
                }
              }
              enqueuePreferred({ url:norm, depth:d });
            }
          }
        }
        linkCount=hrefs.length;
      }
      ok=true;
      console.log(`[CRAWL] d=${item.depth} ok url=${item.url} links=${linkCount}`);
    } catch(e){
      console.log(`[CRAWL_ERR] ${item.url} ${e.message}`);
    } finally {
      try { if(page) await page.close(); } catch {}
    }
  }

  // Product quota tracking (supports quick mode and full-auto plan)
  const perCategoryCounts = new Map();
  let globalProductCount = 0;
  const productCategoryMap = new Map();
  if(structurePlan){
    for(const cat of Object.keys(structurePlan.categoryProducts||{})){
      for(const p of structurePlan.categoryProducts[cat]||[]){ productCategoryMap.set(p, cat); }
    }
  }

  function exceedsProductQuotas(url){
    const isProduct = preferRx && preferRx.test(url) && !(categoryPreferRx && categoryPreferRx.test(url));
    if(!isProduct) return false;
    if(structurePlan){
      if(structurePlan.globalProductCap && globalProductCount >= structurePlan.globalProductCap) return true;
      const cat = productCategoryMap.get(url) || '__uncat__';
      const limit = structurePlan.productsPerCategory || PLAN_PRODUCTS_PER_CATEGORY;
      const current = perCategoryCounts.get(cat)||0;
      if(limit && current >= limit) return true;
      return false;
    }
    if(QUICK_DET_MODE){
      if (TOTAL_PRODUCT_CAP && globalProductCount >= TOTAL_PRODUCT_CAP) return true;
      const catKey='__global__';
      const current= perCategoryCounts.get(catKey)||0;
      if (CATEGORY_PRODUCT_QUOTA && current >= CATEGORY_PRODUCT_QUOTA) return true;
    }
    return false;
  }

  while(queue.length && pagesCrawled < MAX_PAGES){
    if (stopRequested(OUTPUT_DIR)) break;
    if (QUICK_DET_MODE){
      // Re-rank queue deterministically: categories, then products, then normal; each sub-sorted lexicographically
      queue.sort((a,b)=>{
        const rank = {category:0, product:1, normal:2};
        const ra = rank[a.type||'normal'];
        const rb = rank[b.type||'normal'];
        if (ra!==rb) return ra-rb;
        return a.url.localeCompare(b.url);
      });
    }
    const item=queue.shift();
    if (exceedsProductQuotas(item.url)) continue;
    await processItem(item);
    const isProduct = preferRx && preferRx.test(item.url) && !(categoryPreferRx && categoryPreferRx.test(item.url));
    if(isProduct){
      globalProductCount++;
      if(structurePlan){
        const cat = productCategoryMap.get(item.url) || '__uncat__';
        perCategoryCounts.set(cat,(perCategoryCounts.get(cat)||0)+1);
      } else if (QUICK_DET_MODE){
        // Use originCategory tagged when enqueued if present to distribute quota
        const originCat = item.originCategory || '__global__';
        if(!productCategoryMap.has(item.url) && originCat !== '__global__') productCategoryMap.set(item.url, originCat);
        perCategoryCounts.set(originCat,(perCategoryCounts.get(originCat)||0)+1);
      }
    }
  }

  try { await browser.close(); } catch {}

  // seedsForArchive: exactly the visited pages (limit enforced)
  const seedsForArchive = visitedOrder.slice(0, MAX_PAGES);
  // For debugging: full discovered set
  fs.writeFileSync(path.join(crawlDir,'discovered-debug.txt'), Array.from(seen).join('\n')+'\n','utf8');
  // Output only fetched pages to urls.txt
  fs.writeFileSync(path.join(crawlDir,'urls.txt'), seedsForArchive.join('\n')+'\n','utf8');

  // Graph & report use all discovered but highlight actual crawled subset
  fs.writeFileSync(path.join(crawlDir,'graph.json'), JSON.stringify({
    nodes: Array.from(seen).map(u=>({
      url:u,
      depth: depths.get(u) ?? null,
      crawled: visitedOrder.includes(u)
    })),
    edges
  }, null, 2),'utf8');

  fs.writeFileSync(path.join(crawlDir,'report.json'), JSON.stringify({
    startURLs: START_URLS,
    pagesCrawled: visitedOrder.length,
    seedsForArchive: seedsForArchive.length,
    totalDiscovered: seen.size,
    maxDepth: MAX_DEPTH,
    maxPages: MAX_PAGES,
    sameHostOnly: SAME_HOST_ONLY,
    includeSubdomains: INCLUDE_SUBDOMAINS,
    allowRegex: ALLOW_REGEX_STR || null,
    denyRegex: DENY_REGEX_STR || null,
    keepQueryParams: KEEP_QUERY_PARAMS,
    stripAllQueries: STRIP_ALL_QUERIES,
    stoppedEarly: stopRequested(OUTPUT_DIR),
    timestamp: new Date().toISOString()
  }, null, 2),'utf8');

  console.log(`[CRAWL_DONE] discovered=${seen.size} crawled=${visitedOrder.length} seedsForArchive=${seedsForArchive.length}${stopRequested(OUTPUT_DIR)?' (STOP)':''}`);

  if (!seedsForArchive.length){
    process.exit(2);
  }
}

crawl().catch(e=>{
  console.error('CRAWL_FATAL', e);
  process.exit(1);
});