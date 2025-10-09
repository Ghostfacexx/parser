/**
 * structure-detect.cjs
 * Lightweight site structure probe for FULL_AUTO_MODE.
 * Heuristically classifies category vs product pages and generates a deterministic plan.
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function isLikelyProduct(url){
  return /(product|prod|item|sku|detail)/i.test(url) || /-[0-9]{2,}\.html?$/.test(url) || /product-details/i.test(url);
}
function isLikelyCategory(url){
  return /(catalog|category|collection|listing|list)/i.test(url) || /catalog-details/i.test(url);
}

async function loadLinks(browser, url, timeoutMs){
  const context = await browser.newContext({ viewport:{width:1280,height:900} });
  const page = await context.newPage();
  page.setDefaultNavigationTimeout(timeoutMs);
  let hrefs=[];
  try {
    await page.goto(url, { waitUntil:'domcontentloaded' });
    await page.waitForTimeout(400);
    hrefs = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')));
  } catch(_){} finally { try { await page.close(); } catch{}; try { await context.close(); } catch{} }
  return hrefs;
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

async function detectStructure({ startUrls, outputDir, probeCategoryLimit=40, productsPerCategory=10, globalProductCap=400, timeoutMs=15000 }){
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
    productRegex:null,
    categoryRegex:null,
    generatedAt: new Date().toISOString()
  };
  const browser = await chromium.launch({ headless:true, args:['--no-sandbox'] });
  try {
    // Root links
    const rootLinksRaw = await loadLinks(browser, root, timeoutMs);
    const normRootLinks = Array.from(new Set(rootLinksRaw.map(h=>normalize(h, root)).filter(Boolean)));
    // Classify candidates
    const catCandidates = normRootLinks.filter(isLikelyCategory);
    const prodCandidates = normRootLinks.filter(isLikelyProduct);
    plan.categories = catCandidates.slice(0, probeCategoryLimit).sort();
    // For each category, gather product links
    for(const cat of plan.categories){
      if(plan.productList.length >= globalProductCap) break;
      const linksRaw = await loadLinks(browser, cat, timeoutMs);
      const norm = Array.from(new Set(linksRaw.map(h=>normalize(h, cat)).filter(Boolean)));
      const prodLinks = norm.filter(isLikelyProduct).sort();
      const selected = prodLinks.slice(0, productsPerCategory);
      plan.categoryProducts[cat] = selected;
      for(const p of selected){
        if(plan.productList.length < globalProductCap && !plan.productList.includes(p)) plan.productList.push(p);
      }
    }
    // Build regexes
    const catRegex = buildGroupedRegex(plan.categories);
    const prodRegex = buildGroupedRegex(plan.productList);
    plan.categoryRegex = catRegex;
    plan.productRegex = prodRegex;
    // Persist plan
    const crawlDir = path.join(outputDir,'_crawl');
    fs.mkdirSync(crawlDir, { recursive:true });
    fs.writeFileSync(path.join(crawlDir,'plan.json'), JSON.stringify(plan,null,2),'utf8');
    return plan;
  } finally {
    try { await browser.close(); } catch{}
  }
}

module.exports = { detectStructure };
