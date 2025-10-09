/* MARKER: APP_JS_MINIMAL_V2_ADV */
(function(){
  const captureLog = id('captureLog');
  const liveLog    = id('liveLog');
  const hostLog    = id('hostLog');
  const hpLog      = id('hpLog');
  const runsBody   = document.querySelector('#runsTable tbody');
  const jobsBody   = document.querySelector('#jobsTable tbody');
  let selectedRun  = null;
  let platforms    = [];
  logCap('App bootstrap (advanced)');

  // ---------- Utilities
  function id(x){return document.getElementById(x);}
  function asBool(el){ return !!(el && (el.checked || el.value==='true')); }
  function asNum(el, def){ const n = parseInt(el?.value||'',10); return Number.isFinite(n)?n:def; }
  function asStr(el){ return (el?.value||'').trim(); }
  function lines(el){ return asStr(el).split(/\r?\n/).map(s=>s.trim()).filter(Boolean).join('\n'); }
  function append(el,msg){ if(!el) return; el.textContent += msg+'\n'; if(el.textContent.length>30000) el.textContent=el.textContent.slice(-25000); el.scrollTop=el.scrollHeight; console.log('[UI]',msg); }
  function logCap(m){ append(captureLog,m); }
  function logLive(m){ append(liveLog,m); }
  function logHost(m){ append(hostLog,m); }
  function logHP(m){ append(hpLog,m); }
  function fetchJSON(url,opts){ logCap('fetch '+url); return fetch(url,opts).then(r=>{ logCap('fetch '+url+' status='+r.status); if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }); }
  function fmtTime(t){ if(!t) return '-'; try{ return new Date(t).toLocaleTimeString(); }catch{return '-';} }

  window.onerror=(m,src,l,c,e)=>logCap('ERROR '+m+' @'+l+':'+c);
  window.onunhandledrejection=e=>logCap('PROMISE_REJECTION '+(e.reason?.message||e.reason));

  // ---------- SSE
  try{
    const es=new EventSource('/api/logs');
    es.onmessage=e=>{
      const line=e.data;
      logLive(line);
      try{ handleLiveLine(line); }catch(err){ /* ignore */ }
      if(/JOB_START|JOB_EXIT|CRAWL_EXIT|AUTO_EXPAND_EXIT/.test(e.data)) setTimeout(loadRuns,600);
    };
  }catch(e){ logLive('SSE error '+e.message); }

  // ---------- Runs
  function renderRuns(list){
    runsBody.innerHTML = (list||[]).map(r=>{
      const pages = r.stats?.pages ?? r.stats?.pagesCrawled ?? (r.pending?'�':'-');
      const fails = r.stats?.failures ?? 0;
      const assets = r.stats?.assets ?? '-';
      return `<tr data-run="${r.id}" class="${r.pending?'pending':''}">
        <td>${r.id}</td>
        <td>${fmtTime(r.startedAt)}</td>
        <td>${pages}</td>
        <td>${fails}</td>
        <td>${assets}</td>
        <td><button data-act="sel" data-run="${r.id}" style="font-size:.55rem">Select</button></td>
      </tr>`;
    }).join('');
  }
  function loadRuns(){ return fetchJSON('/api/runs').then(j=>renderRuns(j.runs||[])).catch(e=>logCap('loadRuns err '+e.message)); }

  runsBody.addEventListener('click',e=>{
    const act=e.target.getAttribute('data-act');
    if(act==='sel'){
      selectedRun = e.target.getAttribute('data-run');
      id('hostRun').value = selectedRun;
      logCap('Selected run '+selectedRun);
      id('hpNotice').textContent = 'Selected run: '+selectedRun;
    }
  });

  // ---------- Build capture options
  function buildOptions(){
    const opts={};
    if(id('optProfiles').checked) opts.profiles='desktop,mobile';
    if(id('optAggressive').checked) opts.aggressiveCapture=true;
    if(id('optPreserve').checked) opts.preserveAssetPaths=true;
    if(id('optScroll').checked) { opts.scrollPasses=2; }

    // Deterministic / Full Auto modes
    if(id('modeQuickDet')?.checked) opts.quickDeterministic = true;
    if(id('modeFullAuto')?.checked) opts.fullAutoPlan = true;
    if(id('modeReuseProfile')?.checked) opts.reuseDomainProfile = true;
    if(id('modeForceRebuild')?.checked) opts.forceRebuildPlan = true;
    const ppc = asNum(id('planProductsPerCat'),0); if(ppc>0) opts.planProductsPerCategory = ppc;
    const pgc = asNum(id('planGlobalCap'),0); if(pgc>0) opts.planGlobalProductCap = pgc;
    const pto = asNum(id('planTimeout'),0); if(pto>0) opts.planTimeoutMs = pto;
    const qpc = asNum(id('quickPerCatQuota'),0); if(qpc>0) opts.quickPerCategoryQuota = qpc;
    const qtc = asNum(id('quickTotalCap'),0); if(qtc>0) opts.quickTotalProductCap = qtc;

    // Auto-expand
    const adepth = asNum(id('autoDepth'),0);
    if(adepth>0){
      opts.autoExpandDepth = adepth;
      opts.autoExpandMaxPages = asNum(id('autoMaxPages'),120);
      opts.autoExpandSameHostOnly = asBool(id('autoSameHost'));
      opts.autoExpandSubdomains = asBool(id('autoSubs'));
      opts.autoExpandIncludeProducts = asBool(id('autoIncludeProducts'));
      const allow = asStr(id('autoAllow')); if(allow) opts.autoExpandAllowRegex = allow;
      const deny = asStr(id('autoDeny'));   if(deny)  opts.autoExpandDenyRegex  = deny;
    }

    // Advanced capture
    opts.engine = asStr(id('advEngine')) || 'chromium';
    opts.concurrency = asNum(id('advConcurrency'),2);
    opts.headless = (id('advHeadless')?.value!=='false');

    opts.pageWaitUntil = asStr(id('advWaitUntil')) || 'domcontentloaded';
    opts.waitExtra     = asNum(id('advWaitExtra'),700);
    opts.quietMillis   = asNum(id('advQuietMillis'),1500);
    opts.navTimeout    = asNum(id('advNavTimeout'),20000);
    opts.pageTimeout   = asNum(id('advPageTimeout'),40000);
    opts.maxCaptureMs  = asNum(id('advMaxCapMs'),15000);
    opts.scrollDelay   = asNum(id('advScrollDelay'),250);

    const inlineSmall = asNum(id('advInlineSmall'),0); if(inlineSmall>0) opts.inlineSmallAssets = inlineSmall;
    const assetMax    = asNum(id('advAssetMax'),0);    if(assetMax>0)    opts.assetMaxBytes    = assetMax;

    opts.rewriteInternal     = asBool(id('advRewriteInternal'));
    opts.mirrorSubdomains    = asBool(id('advMirrorSubs'));
    opts.mirrorCrossOrigin   = asBool(id('advMirrorCross'));
    opts.includeCrossOrigin  = asBool(id('advIncludeCO'));
    opts.rewriteHtmlAssets   = asBool(id('advRewriteHtmlAssets'));
    opts.flattenRoot         = asBool(id('advFlattenRoot'));

    const internalRx = asStr(id('advInternalRegex')); if(internalRx) opts.internalRewriteRegex = internalRx;
    const domainFilter = asStr(id('advDomainFilter')); if(domainFilter) opts.domainFilter = domainFilter;

    const clickSel = lines(id('advClickSelectors')); if(clickSel) opts.clickSelectors = clickSel;
    const remSel   = lines(id('advRemoveSelectors')); if(remSel) opts.removeSelectors = remSel;
    const skipPat  = lines(id('advSkipDownload')); if(skipPat) opts.skipDownloadPatterns = skipPat;

    // Consent
    const btns = lines(id('advConsentButtons')); if(btns) opts.consentButtonTexts = btns;
    const extra= lines(id('advConsentExtraSel')); if(extra) opts.consentExtraSelectors = extra;
    const force= lines(id('advConsentForceRemove')); if(force) opts.consentForceRemoveSelectors = force;
    opts.consentRetryAttempts = asNum(id('advConsentRetries'),12);
    opts.consentRetryInterval = asNum(id('advConsentInterval'),700);
    opts.consentMutationWindow= asNum(id('advConsentWindow'),8000);
    opts.consentIframeScan    = asBool(id('advConsentIframeScan'));
    opts.consentDebug         = asBool(id('advConsentDebug'));
    opts.consentDebugScreenshot = asBool(id('advConsentScreenshot'));
    if(asBool(id('advForceConsentWait'))){
      opts.forceConsentWaitMs = asNum(id('advForceConsentWaitMs'),0);
    }
    return opts;
  }

  // ---------- Start Run
  id('btnStart').onclick = ()=>{
    const urls = asStr(id('seedInput')).split(/\n+/).filter(Boolean);
    if(!urls.length){ alert('Enter at least one URL'); return; }
    const options = buildOptions();
    id('btnStart').disabled=true; id('btnStop').disabled=false;
    logCap('POST /api/run start');
    fetch('/api/run',{ method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ urlsText: urls.join('\n'), options }) })
    .then(r=>r.json()).then(j=>{
      logCap('Run response '+JSON.stringify(j));
      if(j.runId){ setTimeout(loadRuns,900); }
      else { id('btnStart').disabled=false; id('btnStop').disabled=true; }
    }).catch(e=>{
      logCap('Run start error '+e.message);
      id('btnStart').disabled=false; id('btnStop').disabled=true;
    });
  };

  // ---------- Crawl First
  id('btnStartCrawlFirst').onclick = ()=>{
    const startUrls = asStr(id('crawlSeeds')).split(/\n+/).filter(Boolean).join('\n');
    if(!startUrls){ alert('Enter crawl seeds'); return; }
    const options = buildOptions();
    const crawlOptions = {
      maxDepth:   asNum(id('crawlDepth'),3),
      maxPages:   asNum(id('crawlMaxPages'),200),
      waitAfterLoad: asNum(id('crawlWait'),500),
      sameHostOnly:  asBool(id('crawlSameHost')),
      includeSubdomains: asBool(id('crawlSubs')),
      allowRegex: asStr(id('crawlAllow')),
      denyRegex:  asStr(id('crawlDeny'))
    };
    id('btnStart').disabled=true; id('btnStop').disabled=false;
    logCap('POST /api/run (crawlFirst)');
    fetch('/api/run',{ method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ urlsText:'', options, crawlFirst:true, crawlOptions:{...crawlOptions,startUrlsText:startUrls} }) })
    .then(r=>r.json()).then(j=>{
      logCap('Run response '+JSON.stringify(j));
      if(j.runId){ setTimeout(loadRuns,1200); }
      else { id('btnStart').disabled=false; id('btnStop').disabled=true; }
    }).catch(e=>{
      logCap('Run start error '+e.message);
      id('btnStart').disabled=false; id('btnStop').disabled=true;
    });
  };

  // ---------- Stop Run / Refresh
  id('btnStop').onclick=()=>{
    fetch('/api/stop-run',{method:'POST'}).then(r=>r.json()).then(j=>{
      logCap('Stop run '+JSON.stringify(j));
      id('btnStop').disabled=true; id('btnStart').disabled=false;
      setTimeout(loadRuns,800);
    }).catch(e=>logCap('Stop error '+e.message));
  };
  id('btnForceRefresh').onclick=()=>loadRuns();

  // ---------- Hosting
  id('btnHost').onclick=()=>{
    if(!selectedRun) return alert('Select a run');
    const port=+id('hostPort').value||8081;
    fetch('/api/host-run',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({runId:selectedRun,port})})
      .then(r=>r.json()).then(j=>{
        if(!j.ok){ logHost('Host error '+JSON.stringify(j)); return; }
        logHost('Hosting '+j.runId+' @ '+j.url); id('btnStopHost').disabled=false;
      }).catch(e=>logHost('Host exception '+e.message));
  };
  id('btnStopHost').onclick=()=>{
    fetch('/api/stop-host',{method:'POST'}).then(r=>r.json()).then(j=>{
      logHost('Stop host '+JSON.stringify(j)); id('btnStopHost').disabled=true;
    }).catch(e=>logHost('Stop host error '+e.message));
  };

  // Host details (pages and subdomains)
  const hostDetailsBtn = id('btnHostDetails');
  if (hostDetailsBtn){
    hostDetailsBtn.onclick = ()=>{
      const runId = id('hostRun')?.value?.trim();
      if(!runId){ logHost('No run selected'); return; }
      Promise.all([
        fetch(`/api/manifest?id=${encodeURIComponent(runId)}`).then(r=> r.ok ? r.json() : Promise.reject(new Error('manifest not found'))),
        fetch('/api/hosts').then(r=> r.ok ? r.json() : { hosts: [] }).catch(()=>({ hosts: [] }))
      ]).then(([mf, hosts])=>{
        try{
          const recs = Array.isArray(mf) ? mf : [];
          const desktop = recs.filter(r=>r && r.profile==='desktop');
          const paths = desktop.map(r=> r.relPath || 'index');
          const origins = new Set();
          recs.forEach(r=>{ try{ origins.add(new URL(r.url).hostname); }catch{} });
          const hostEntry = (hosts && hosts.hosts || []).find(h=> String(h.runId) === String(runId));
          const base = hostEntry ? (window.location.protocol + '//' + window.location.hostname + ':' + hostEntry.port) : '';
          const list = paths.slice(0,1000).map(p=>{
            const pathPart = '/' + (p==='index' ? '' : (p.replace(/^\/+/, '') + '/'));
            const href = base ? (base + pathPart) : pathPart;
            return `<li><a href="${href}" target="_blank">${href}</a></li>`;
          }).join('');
          id('hostDetails').innerHTML = `
            <div class="badge">pages: ${paths.length}</div>
            <div class="small">subdomains: ${[...origins].sort().join(', ') || '-'}</div>
            <div class="small">host: ${hostEntry ? (window.location.hostname + ':' + hostEntry.port) : '(not started)'}</div>
            <details style="margin-top:.3rem"><summary>Browsable paths</summary><ul>${list}</ul></details>
          `;
        }catch(e){ id('hostDetails').textContent = 'Error building details: '+e.message; }
      }).catch(e=>{ id('hostDetails').textContent = 'Error: '+e.message; });
    };
  }

  // Analyze pages (page-map)
  const hostAnalyzeBtn = id('btnHostAnalyze');
  if (hostAnalyzeBtn){
    hostAnalyzeBtn.onclick = ()=>{
      const runId = id('hostRun')?.value?.trim();
      if(!runId){ logHost('No run selected'); return; }
      fetch(`/api/page-map?runId=${encodeURIComponent(runId)}`)
        .then(r=> r.ok ? r.json() : Promise.reject(new Error('page-map failed')))
        .then(js=>{
          try{
            const map = js.map || {};
            const counts = map.counts || {};
            const base = window.location.origin;
            function listToHtml(arr){
              return (arr||[]).slice(0,200).map(x=>{
                const href = (x && x.url) ? x.url : '';
                let pathPart = '/';
                try { const u = new URL(href); pathPart = u.pathname.endsWith('/') ? u.pathname : (u.pathname + '/'); } catch {}
                const full = base + pathPart;
                const title = x && x.title ? x.title : pathPart;
                return `<li><a href="${full}" target="_blank">${title}</a></li>`;
              }).join('');
            }
            id('hostDetails').innerHTML = `
              <div class="badge">seeds: ${counts.seeds||0}</div>
              <div class="badge">home: ${counts.home||0}</div>
              <div class="badge">categories: ${counts.categories||0}</div>
              <div class="badge">information: ${counts.information||0}</div>
              <div class="badge">others: ${counts.others||0}</div>
              <details style="margin-top:.3rem"><summary>Home</summary><ul>${listToHtml(map.home)}</ul></details>
              <details><summary>Categories</summary><ul>${listToHtml(map.categories)}</ul></details>
              <details><summary>Information</summary><ul>${listToHtml(map.information)}</ul></details>
              <details><summary>Others</summary><ul>${listToHtml(map.others)}</ul></details>
            `;
          }catch(e){ id('hostDetails').textContent = 'Analyze error: '+e.message; }
        })
        .catch(e=>{ id('hostDetails').textContent = 'Analyze call failed: '+e.message; });
    };
  }

  // ---------- Hosting Prep
  function loadPlatforms(){
    fetchJSON('/api/hosting-presets').then(j=>{
      platforms = j.platforms||[];
      id('hpPlatform').innerHTML = platforms.map(p=>`<option value="${p.id}">${p.label||p.id}</option>`).join('');
    }).catch(e=>logHP('platforms err '+e.message));
  }
  id('btnSuggest').onclick=()=>{
    if(!selectedRun) return logHP('No run selected');
    fetchJSON('/api/runs/'+selectedRun+'/prepare-suggestions').then(s=>{
      logHP('Suggest: pages='+s.pages+' mobile='+s.hasMobile+' assets�'+s.totalAssetsApprox+' analytics='+s.analyticsMatches);
      id('hpMobile').checked=s.hasMobile;
      if(s.recommendations.stripAnalytics) id('hpStrip').checked=true;
      if(s.recommendations.precompress) id('hpCompress').checked=true;
      if(!s.recommendations.noServiceWorker) id('hpSW').checked=true;
      if(s.recommendations.baseUrl && !id('hpBaseUrl').value) id('hpBaseUrl').value=s.recommendations.baseUrl;
      const mode=s.recommendations.mode||'desktop';
      const r=document.querySelector(`input[name="hpMode"][value="${mode}"]`); if(r) r.checked=true;
    }).catch(e=>logHP('Suggest error '+e.message));
  };
  id('btnPreparePkg').onclick=()=>{
    if(!selectedRun) return logHP('No run selected');
    const mode=(document.querySelector('input[name="hpMode"]:checked')||{}).value || 'switch';
    const payload={
      runId:selectedRun,
      options:{
        mode,
        includeMobile:id('hpMobile').checked,
        stripAnalytics:id('hpStrip').checked,
        serviceWorker:id('hpSW').checked,
        precompress:id('hpCompress').checked,
        sitemap:id('hpSitemap').checked,
        baseUrl:id('hpBaseUrl').value.trim(),
        extraAnalyticsRegex:id('hpExtraRegex').value.trim(),
        platform:id('hpPlatform').value,
        shopifyEmbed:id('hpShopify').checked,
        createZip:id('hpZip').checked
      }
    };
    logHP('POST prepare '+JSON.stringify(payload));
    fetch('/api/hosting/prepare',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
      .then(r=>r.json()).then(j=>{ logHP('Prepare response '+JSON.stringify(j)); refreshJobs(); })
      .catch(e=>logHP('Prepare error '+e.message));
  };
  id('btnRefreshJobs').onclick=refreshJobs;
  function refreshJobs(){
    fetchJSON('/api/hosting/jobs').then(j=>{
      jobsBody.innerHTML = j.map(job=>`<tr>
        <td>${job.id}</td><td>${job.status}</td>
        <td>${job.zip?`<a class="zipLink" href="/api/hosting/jobs/${job.id}/download">zip</a>`:''}</td>
        <td>${job.runId}</td>
        <td><button data-j="${job.id}" style="font-size:.55rem">Log</button></td>
      </tr>`).join('');
    }).catch(e=>logHP('jobs err '+e.message));
  }
  jobsBody.addEventListener('click',e=>{
    const idAttr=e.target.getAttribute('data-j');
    if(!idAttr) return;
    fetchJSON('/api/hosting/jobs/'+idAttr).then(job=>{
      logHP('Job '+idAttr+' status='+job.status);
      if(job.log) logHP(job.log.slice(-40).join('\n'));
    }).catch(e2=>logHP('job view err '+e2.message));
  });

  // ---------- Init
  loadRuns(); loadPlatforms(); refreshJobs(); logCap('Init complete (advanced)');
  // Live stats state
  const liveStatsEl = id('liveStats');
  const liveStatsDetail = id('liveStatsDetail');
  const stat = {
    planHash:'', planCats:0, planProducts:0, planReused:false,
    pagesCrawled:0, pagesDiscovered:0,
    productsCrawled:0, categoriesCrawled:0,
    startedAt: Date.now(), lastEvent: ''
  };
  function renderStats(){
    if(!liveStatsEl) return;
    const items=[
      ['Plan Hash', stat.planHash||'-'],
      ['Plan Cats', stat.planCats],
      ['Plan Prods', stat.planProducts],
      ['Reused', stat.planReused?'yes':'no'],
      ['Crawled Pages', stat.pagesCrawled],
      ['Discovered', stat.pagesDiscovered],
      ['Prod Crawled', stat.productsCrawled],
      ['Cat Crawled', stat.categoriesCrawled],
      ['Last', stat.lastEvent?new Date(stat.lastEvent).toLocaleTimeString():'-']
    ];
      liveStatsEl.innerHTML = items.map(([k,v])=>`<div style="flex:0 0 auto;background:linear-gradient(135deg,#0a57ff,#0846cc);color:#fff;padding:.45rem .6rem;border-radius:10px;min-width:92px;box-shadow:0 2px 4px rgba(0,0,0,.15);display:flex;flex-direction:column;justify-content:center;align-items:center"><div style="font-size:.55rem;letter-spacing:.5px;text-transform:uppercase;opacity:.85">${k}</div><div style="font-weight:600;font-size:.78rem;margin-top:.15rem">${v}</div></div>`).join('');
  }
  function handleLiveLine(line){
    // PLAN lines
    let m;
    if((m=line.match(/^\[PLAN_REUSE\].*hash=([^\s]+).*cats=(\d+) products=(\d+)/))){
      stat.planHash=m[1]; stat.planCats=+m[2]; stat.planProducts=+m[3]; stat.planReused=true; stat.lastEvent=Date.now(); renderStats(); return; }
    if((m=line.match(/^\[PLAN_APPLY\] cats=(\d+) products=(\d+) hash=([^\s]+)/))){
      stat.planCats=+m[1]; stat.planProducts=+m[2]; stat.planHash=m[3]; stat.planReused=false; stat.lastEvent=Date.now(); renderStats(); return; }
    if((m=line.match(/^\[PLAN_DONE\] categories=(\d+) products=(\d+) hash=([^\s]+)/))){
      stat.planCats=+m[1]; stat.planProducts=+m[2]; stat.planHash=m[3]; stat.lastEvent=Date.now(); renderStats(); return; }
    if((m=line.match(/^\[PLAN_START\]/))){ stat.lastEvent=Date.now(); renderStats(); return; }
    // Crawl progress lines - expecting format like: [CRAWL] d=0 ok url=... (we'll increment)
    if(line.startsWith('[CRAWL]')){ stat.pagesCrawled++; stat.lastEvent=Date.now(); renderStats(); }
    if(line.startsWith('[CRAWL_DONE]')){ // extract discovered and crawled counts if present
      const dm=line.match(/discovered=(\d+) crawled=(\d+)/i);
      if(dm){ stat.pagesDiscovered=+dm[1]; stat.pagesCrawled=+dm[2]; }
      stat.lastEvent=Date.now(); renderStats();
    }
    // Attempt to infer product vs category from URL classification (heuristic regexes)
    if(line.startsWith('[CRAWL]')){
      const urlMatch=line.match(/url=([^\s]+)/);
      if(urlMatch){
        const u=urlMatch[1];
        if(/(product|sku|item|prod)/i.test(u)) stat.productsCrawled++;
        if(/(category|collections|cat)/i.test(u)) stat.categoriesCrawled++;
      }
    }
    // Keep limited detailed tail
    if(liveStatsDetail){
      liveStatsDetail.textContent += line+'\n';
      if(liveStatsDetail.textContent.length>24000) liveStatsDetail.textContent = liveStatsDetail.textContent.slice(-20000);
    }
  }
  renderStats();

  // ---------- Plan Preview
  const planBtn = id('btnLoadPlan');
  if(planBtn){
    planBtn.onclick = ()=>{
      const explicit = asStr(id('planRunId'));
      const runId = explicit || selectedRun;
      if(!runId){ logCap('Plan load: select run first'); return; }
      id('planPreview').textContent='Loading plan...';
      fetch('/api/plan?runId='+encodeURIComponent(runId))
        .then(r=>{ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); })
        .then(j=>{
          const p=j.plan||{};
            const cats=p.categories||[]; const prods=p.productList||[];
            const catProducts=p.categoryProducts||{};
            const lines=[];
            lines.push('Hash: '+(j.hash||''));
            lines.push('Categories: '+cats.length+' Products: '+prods.length+' Groups:'+Object.keys(catProducts).length);
            cats.slice(0,200).forEach((c,i)=>{ lines.push(`CAT[${i}] ${c} products=${(catProducts[c]||[]).length}`); });
            prods.slice(0,300).forEach((u,i)=>{ lines.push(`PROD[${i}] ${u}`); });
            id('planPreview').textContent=lines.join('\n');
        })
        .catch(e=>{ id('planPreview').textContent='Plan load error: '+e.message; });
    };
  }
})();