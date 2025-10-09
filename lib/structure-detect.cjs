/**
 * structure-detect.cjs
 * Extended site structure probe for FULL_AUTO_MODE.
 * Adds semantic signals (JSON-LD Product, price tokens), pagination detection and plan hashing.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const crypto = require('crypto');

function isLikelyProduct(url){
  return /(product|prod|item|sku|detail)/i.test(url) || /-[0-9]{2,}\.html?$/.test(url) || /product-details/i.test(url);
}
function isLikelyCategory(url){
  return /(catalog|category|collection|listing|list)/i.test(url) || /catalog-details/i.test(url);
}

async function loadPageExtract(browser, url, timeoutMs){
  const context = await browser.newContext({ viewport:{width:1280,height:900} });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(timeoutMs);
  let hrefs=[]; let html=''; let jsonLdBlocks=[]; let priceTokens=0; let paginationLinks=[];
  try {
    await page.goto(url, { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(400);
    hrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')));
    html = await page.content();
    // Collect JSON-LD Product blocks
    jsonLdBlocks = await page.$$eval('script[type="application/ld+json"]', els => els.map(e=>e.textContent||''));
    // Simple price token counting (e.g., 199.90, 199, 199,00 with currency symbols/abbrev)
    const priceRegex = /(?:\b|^)(\d{2,5}(?:[.,]\d{2})?)\s?(?:€|eur|лв|lv|usd|\$)/ig;
    const priceMatches = html.match(priceRegex);
    priceTokens = priceMatches ? priceMatches.length : 0;
    // Pagination: look for rel=next or page indicators in hrefs
    paginationLinks = await page.$$eval('a[rel="next"], a[rel="prev"], a[href*="page=2"], a[href*="/page/2"], a[href*="?p=2"], a[href*="?page=2"]', as => as.map(a=>a.getAttribute('href')));
  } catch(_){} finally { try { await page.close(); } catch{}; try { await context.close(); } catch{} }
  return { hrefs, html, jsonLdBlocks, priceTokens, paginationLinks };
}

function normalize(url, base){
  try { return new URL(url, base).toString().replace(/(#.*)$/,''); } catch { return null; }
}

/**
 * Build a generic grouped regex from a list of URLs' path basenames.
 */
function buildGroupedRegex(urls){
  const bases = Array.from(new Set(urls.map(u=>{
    try { return new URL(u).pathname.split('/').filter(Boolean).pop(); } catch { return null; }
  }).filter(Boolean)));
  if(!bases.length) return null;
  // Escape dots
  const parts = bases.map(b=>b.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
  if(parts.length > 40){
    // Too many specifics; fallback to broad heuristic
    return '/[a-z0-9-]*[0-9][a-z0-9-]*\\.html$';
  }
  return `/(?:${parts.join('|')})$/`;
}

async function detectStructure({ startUrls, outputDir, probeCategoryLimit=40, productsPerCategory=10, globalProductCap=400, timeoutMs=15000, paginationMaxPages=5 }){
  if(!startUrls.length) throw new Error('No startUrls');
  const root = startUrls[0];
  const plan = {
    version:1,
    root,
    categories:[],
    categoryProducts:{},
    productList:[],
    productsPerCategory,
    globalProductCap,
    pagination: {},
    productRegex:null,
    categoryRegex:null,
    signals:{},
    generatedAt: new Date().toISOString()
  };
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox'] });
  try {
    // Root page probe
    const rootProbe = await loadPageExtract(browser, root, timeoutMs);
    const normRootLinks = Array.from(new Set(rootProbe.hrefs.map(h=>normalize(h, root)).filter(Boolean)));
    // Classify candidates
    const catCandidates = normRootLinks.filter(isLikelyCategory);
    const prodCandidates = normRootLinks.filter(isLikelyProduct);
    plan.categories = catCandidates.slice(0, probeCategoryLimit).sort();
    plan.signals.rootPriceTokens = rootProbe.priceTokens;
    plan.signals.rootJsonLdProducts = rootProbe.jsonLdBlocks.filter(b=>/"@type"\s*:\s*"Product"/i.test(b)).length;
    // For each category, gather product links
    for(const cat of plan.categories){
      if(plan.productList.length >= globalProductCap) break;
      const catProbe = await loadPageExtract(browser, cat, timeoutMs);
      const norm = Array.from(new Set(catProbe.hrefs.map(h=>normalize(h, cat)).filter(Boolean)));
      const jsonLdCount = catProbe.jsonLdBlocks.filter(b=>/"@type"\s*:\s*"Product"/i.test(b)).length;
      const catSignal = { priceTokens: catProbe.priceTokens, jsonLdProducts: jsonLdCount };
      plan.signals[cat] = catSignal;
      // Pagination discovery
      if(catProbe.paginationLinks && catProbe.paginationLinks.length){
        const nextLink = catProbe.paginationLinks.map(h=>normalize(h, cat)).filter(Boolean).find(h=>/(page=2|\/page\/2|[?&]p=2)/i.test(h));
        if(nextLink){
          plan.pagination[cat] = { firstPage: cat, page2: nextLink, patternHint: derivePaginationPattern(cat, nextLink) };
        }
      }
      const prodLinks = norm.filter(isLikelyProduct).sort();
      const selected = prodLinks.slice(0, productsPerCategory);
      plan.categoryProducts[cat] = selected;
      for(const p of selected){
        if(plan.productList.length < globalProductCap && !plan.productList.includes(p)) plan.productList.push(p);
      }
      // Optionally follow pagination pages (basic pattern) up to paginationMaxPages
      const pagInfo = plan.pagination[cat];
      if(pagInfo && pagInfo.patternHint){
        for(let p=2;p<=paginationMaxPages;p++){
          const candidate = pagInfo.patternHint.replace('{N}', String(p));
          if(!candidate || candidate===cat) continue;
          try {
            const pageProbe = await loadPageExtract(browser, candidate, timeoutMs);
            const pageNorm = Array.from(new Set(pageProbe.hrefs.map(h=>normalize(h, candidate)).filter(Boolean)));
            const moreProducts = pageNorm.filter(isLikelyProduct).sort();
            for(const mp of moreProducts){
              if(plan.productList.length >= globalProductCap) break;
              if(!plan.categoryProducts[cat].includes(mp)){
                if(plan.categoryProducts[cat].length < productsPerCategory){
                  plan.categoryProducts[cat].push(mp);
                  plan.productList.push(mp);
                }
              }
            }
            if(plan.categoryProducts[cat].length >= productsPerCategory) break;
          } catch {}
        }
      }
      console.log(`[PLAN_PROGRESS] stage=category_page catSampledProducts=${plan.categoryProducts[cat].length} totalProducts=${plan.productList.length}`);
    }
    // Build regexes
    const catRegex = buildGroupedRegex(plan.categories);
    const prodRegex = buildGroupedRegex(plan.productList);
    plan.categoryRegex = catRegex;
    plan.productRegex = prodRegex;
    // Hash for determinism verification
    const hash = crypto.createHash('sha1').update(JSON.stringify({root, categories:plan.categories, products:plan.productList})).digest('hex').slice(0,12);
    plan.hash = hash;
    // Persist plan
    const crawlDir = path.join(outputDir,'_crawl');
    fs.mkdirSync(crawlDir, { recursive:true });
    fs.writeFileSync(path.join(crawlDir,'plan.json'), JSON.stringify(plan,null,2),'utf8');
    console.log(`[PLAN] categories=${plan.categories.length} products=${plan.productList.length} hash=${hash}`);
    return plan;
  } finally {
    try { await browser.close(); } catch{}
  }
}

function derivePaginationPattern(catUrl, page2Url){
  try {
    const u1=new URL(catUrl); const u2=new URL(page2Url);
    if(u1.origin!==u2.origin) return null;
    // Common patterns: ?page=1 -> replace number, /page/2/ -> replace number
    if(u2.searchParams.has('page')){
      return u2.origin + u2.pathname + '?page={N}';
    }
    if(/\/page\/2/i.test(u2.pathname)){
      return u2.origin + u2.pathname.replace(/\/page\/2/i,'/page/{N}');
    }
    if(u2.searchParams.has('p')){
      return u2.origin + u2.pathname + '?p={N}';
    }
  }catch{}
  return null;
}

module.exports = { detectStructure };
