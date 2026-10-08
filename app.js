(function(){
  'use strict';
  var PRESETS=['강남맛집','리뷰노트','레뷰','포포몬','댓글 쪽지'];
  var LS='chexdan.items.v1', DRAFT='chexdan.draft.v2', TPL='chexdan.tpl.v2';
  var WD=['일','월','화','수','목','금','토'];
  var REQ=['store','offer','deadline','phone','platform','keywords','notice'];
  var FN={store:'가게 이름',offer:'제공 내역',deadline:'마감일',phone:'연락처',platform:'플랫폼',keywords:'필수 키워드',notice:'예약 유의사항'};
  var items=[], templates={}, editing=null, filter='active', pf='', delTimer=null;
  var formPlat='', customOpen=false, formKw=[], miss=[], pendingImgs=[], thumbUrls=[];
  var busy=false, cancelled=false, worker=null, fmtPlat='';
  var $=function(s){return document.querySelector(s)};

  function lsGet(k,d){try{var v=localStorage.getItem(k);return v?JSON.parse(v):d}catch(e){return d}}
  function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch(e){}}
  function lsDel(k){try{localStorage.removeItem(k)}catch(e){}}
  function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function p2(n){return (n<10?'0':'')+n}
  function uid(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6)}
  function ymd(d){return d.getFullYear()+'-'+p2(d.getMonth()+1)+'-'+p2(d.getDate())}

  /* ---------- 사진 임시 보관(이 기기 IndexedDB) ---------- */
  var idbp=null;
  function idb(){
    if(idbp)return idbp;
    idbp=new Promise(function(res,rej){
      try{var r=indexedDB.open('chexdan-img',1);
        r.onupgradeneeded=function(){r.result.createObjectStore('imgs')};
        r.onsuccess=function(){res(r.result)};r.onerror=function(){rej(r.error)};
      }catch(e){rej(e)}
    });
    return idbp;
  }
  function idbRun(mode,fn){
    return idb().then(function(db){return new Promise(function(res,rej){
      var tx=db.transaction('imgs',mode),rq=fn(tx.objectStore('imgs'));
      tx.oncomplete=function(){res(rq&&rq.result)};
      tx.onerror=tx.onabort=function(){rej(tx.error)};
    })});
  }
  function idbPut(k,v){return idbRun('readwrite',function(st){return st.put(v,k)}).catch(function(){})}
  function idbGet(k){return idbRun('readonly',function(st){return st.get(k)}).catch(function(){return null})}
  function idbDel(k){return idbRun('readwrite',function(st){return st.delete(k)}).catch(function(){})}

  function daysLeft(s){
    var a=s.split('-').map(Number), t=new Date();
    return Math.round((Date.UTC(a[0],a[1]-1,a[2])-Date.UTC(t.getFullYear(),t.getMonth(),t.getDate()))/864e5);
  }
  function fmtDate(s){var a=s.split('-').map(Number);return p2(a[1])+'.'+p2(a[2])+' ('+WD[new Date(a[0],a[1]-1,a[2]).getDay()]+')'}
  function dLabel(n){return n===0?'D-DAY':n>0?'D-'+n:'D+'+(-n)}
  function validDate(y,m,d){
    var dt=new Date(y,m-1,d);
    return (dt.getFullYear()===y&&dt.getMonth()===m-1&&dt.getDate()===d)?y+'-'+p2(m)+'-'+p2(d):'';
  }
  function fmtPhone(v){
    var d=v.replace(/\D/g,'').slice(0,11);
    if(d.indexOf('02')===0){
      if(d.length<=2)return d;
      if(d.length<=6)return d.slice(0,2)+'-'+d.slice(2);
      return d.slice(0,2)+'-'+d.slice(2,d.length-4)+'-'+d.slice(d.length-4);
    }
    if(d.length<=3)return d;
    if(d.length<=7)return d.slice(0,3)+'-'+d.slice(3);
    return d.slice(0,3)+'-'+d.slice(3,7)+'-'+d.slice(7);
  }
  function platforms(){
    var extra=[];
    items.forEach(function(i){if(i.platform&&PRESETS.indexOf(i.platform)<0&&extra.indexOf(i.platform)<0)extra.push(i.platform)});
    if(formPlat&&PRESETS.indexOf(formPlat)<0&&extra.indexOf(formPlat)<0)extra.push(formPlat);
    return PRESETS.concat(extra);
  }
  var toastT;
  function toast(m){var t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove('on')},2400)}

  function saveItems(){lsSet(LS,items)}
  function removeItem(id){items=items.filter(function(i){return i.id!==id});saveItems();idbDel(id);render()}

  /* =====================================================
     글자 인식 결과 → 항목 매칭 (규칙 기반)
     ===================================================== */
  var DEF={
    offer:['제공서비스/물품','제공 서비스/물품','제공서비스','제공 서비스','제공내역','제공 내역','제공물품','제공 물품'],
    keywords:['키워드 정보','필수 키워드','키워드'],
    phone:['담당자 연락처','업체 연락처','연락처'],
    notice:['방문 및 예약 안내','예약 및 방문 안내','방문 안내','예약 안내','예약 유의사항','예약 및 방문','유의사항'],
    stop:['체험단 미션','캠페인 미션','리뷰 미션','방문 정보','리뷰 작성','리뷰 가이드','신청 정보','체험단 정보','참고사항','추가 안내','기타 안내','선정 안내','리뷰 안내','캠페인 정보','주의사항','위치 정보','매장 정보']
  };
  function norm(s){return String(s).replace(/[\s​|ㅣ]/g,'')}
  function headingTable(plat){
    var rows=[], T=(plat&&templates[plat])||{};
    ['offer','keywords','phone','notice'].forEach(function(f){
      var list=DEF[f].slice();
      String(T[f]||'').split(/[,\n]/).forEach(function(x){x=x.trim();if(x)list.push(x)});
      list.forEach(function(x){rows.push([f,x])});
    });
    DEF.stop.forEach(function(x){rows.push(['stop',x])});
    rows.sort(function(a,b){return norm(b[1]).length-norm(a[1]).length});
    return rows;
  }
  function headingOf(line,table){
    var n=norm(line);
    if(!n||n.length>40)return null;
    for(var i=0;i<table.length;i++){
      var sn=norm(table[i][1]);
      if(n.indexOf(sn)===0&&n.length<=sn.length+6)return {f:table[i][0],s:table[i][1]};
    }
    return null;
  }
  function detectPlatform(text){
    var t=text.toLowerCase().replace(/\s/g,'');
    if(/reviewnote|리뷰노트/.test(t))return '리뷰노트';
    if(/gangnam|강남맛집/.test(t))return '강남맛집';
    if(/popomon|포포몬/.test(t))return '포포몬';
    if(/revu|레뷰/.test(t))return '레뷰';
    return '';
  }
  function calendarDeadline(words){
    var days=[], marks=[];
    words.forEach(function(w){
      var t=String(w.text||'').trim(), b=w.bbox;
      if(!b)return;
      var cx=(b.x0+b.x1)/2, cy=(b.y0+b.y1)/2, h=b.y1-b.y0;
      var m=t.match(/^(\d{1,2})일$/);
      if(m){var n=+m[1];if(n>=1&&n<=31)days.push({n:n,cx:cx,cy:cy,h:h})}
      if(t==='마감')marks.push({cx:cx,cy:cy});
    });
    var best=null;
    marks.forEach(function(mk){
      days.forEach(function(d){
        var dy=mk.cy-d.cy;
        if(dy<=0||dy>d.h*5)return;
        var score=dy+Math.abs(mk.cx-d.cx)*2;
        if(!best||score<best.s)best={s:score,n:d.n,tol:d.h*7};
      });
    });
    if(!best||Math.abs(best.s)>best.tol)return null;
    return best.n;
  }
  function resolveDay(day){
    var t=new Date(), y=t.getFullYear(), m=t.getMonth()+1;
    var today=new Date(y,m-1,t.getDate());
    var cand=validDate(y,m,day);
    if(!cand){m++;if(m>12){m=1;y++}cand=validDate(y,m,day)}
    if(cand){
      var a=cand.split('-').map(Number),dt=new Date(a[0],a[1]-1,a[2]);
      if((dt-today)/864e5<-20){m++;if(m>12){m=1;y++}cand=validDate(y,m,day)||cand}
    }
    return cand;
  }
  function dateFromText(lines){
    var now=new Date(), y=now.getFullYear();
    var order=lines.filter(function(l){return /마감/.test(l)});
    order.sort(function(a,b){return (/리뷰/.test(b)?1:0)-(/리뷰/.test(a)?1:0)});
    for(var i=0;i<order.length;i++){
      var l=order[i], m;
      if((m=l.match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/))){var v=validDate(+m[1],+m[2],+m[3]);if(v)return v}
      if((m=l.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/))||(m=l.match(/(\d{1,2})\s*[./]\s*(\d{1,2})(?!\d)/))){
        var v2=validDate(y,+m[1],+m[2]);
        if(v2){
          var a=v2.split('-').map(Number);
          if((new Date(a[0],a[1]-1,a[2])-now)/864e5<-60)v2=validDate(y+1,+m[1],+m[2])||v2;
          return v2;
        }
      }
    }
    return '';
  }
  function parseOCR(text,words){
    var lines=text.split(/\r?\n/).map(function(l){return l.replace(/\s+/g,' ').trim()}).filter(function(l){return l&&norm(l)!=='복사'&&norm(l)!=='연락처복사'});
    var plat=detectPlatform(text);
    var table=headingTable(plat);
    var hs=lines.map(function(l){return headingOf(l,table)});
    var out={platform:plat,labels:{},calendar:false};
    function section(f){
      var idx=-1;
      for(var i=0;i<lines.length;i++){if(hs[i]&&hs[i].f===f){idx=i;break}}
      if(idx<0)return null;
      var body=[];
      for(var j=idx+1;j<lines.length&&!hs[j];j++)body.push(lines[j]);
      out.labels[f]=hs[idx].s;
      return body;
    }
    // 제목에서 가게 이름
    for(var i=0;i<lines.length;i++){
      var m=lines[i].match(/^\[[^\]]+\]\s*(.+)$/);
      if(m){
        var name=m[1].trim(), nx=lines[i+1];
        if(nx&&!hs[i+1]&&nx.length<=15&&!/[|｜]/.test(nx)&&!/(체험단|신청|방문형|블로그)/.test(nx))name+=' '+nx;
        out.store=name;break;
      }
    }
    var o=section('offer');   if(o&&o.length)out.offer=o.join('\n');
    var k=section('keywords');
    if(k&&k.length){
      var kws=[];
      k.join(' ').split(/[\s,#]+/).forEach(function(x){if(x.length>=2&&kws.indexOf(x)<0&&norm(x)!=='복사')kws.push(x)});
      out.keywords=kws.slice(0,20);
    }
    var n=section('notice');  if(n&&n.length)out.notice=n.join('\n');
    var ph=section('phone'), rx=/(?:01[016789]|0\d{1,2})[-.\s]?\d{3,4}[-.\s]?\d{4}/;
    var pm=ph&&ph.join(' ').match(rx);
    if(!pm){var all=lines.filter(function(l,i){return !(hs[i])}).join(' ');pm=all.match(rx)}
    if(pm)out.phone=fmtPhone(pm[0]);
    var day=calendarDeadline(words||[]);
    if(day){out.deadline=resolveDay(day);out.calendar=true;out.labels.deadline='달력의 마감 표시'}
    else{var dt=dateFromText(lines);if(dt){out.deadline=dt;out.labels.deadline='마감 날짜 글'}}
    return out;
  }

  /* ---------- 카드 ---------- */
  function ticketHTML(it){
    var n=daysLeft(it.deadline);
    var st=it.done?'is-done':n<0?'is-late':n<=3?'is-urgent':n<=7?'is-soon':'';
    var big=it.done?'완료':dLabel(n), id=esc(it.id);
    var h='<article class="ticket '+st+'"><div class="main"><div class="row1">';
    if(it.platform)h+='<span class="tag">'+esc(it.platform)+'</span>';
    if(it.hasImg)h+='<button type="button" class="tag fix" data-act="edit" data-id="'+id+'">사진 확인 필요</button>';
    h+='</div><h3 class="name">'+esc(it.store)+'</h3>';
    if(it.offer)h+='<p class="offer">'+esc(it.offer)+'</p>';
    if(it.phone){
      h+='<div class="tel-row"><a class="tel" href="tel:'+esc(it.phone.replace(/[^\d+]/g,''))+'">'+esc(it.phone)+'</a>'
        +'<button type="button" class="mini" data-act="copy" data-id="'+id+'">복사</button></div>';
    }
    var kws=it.keywords||[];
    if(kws.length){
      h+='<div class="kws">'+kws.map(function(k){return '<span class="kw">'+esc(k)+'</span>'}).join('')
        +'<button type="button" class="mini" data-act="copykw" data-id="'+id+'">키워드 복사</button></div>';
    }
    if(it.notice)h+='<details class="note"><summary>예약 유의사항</summary><p>'+esc(it.notice)+'</p></details>';
    if(it.memo)h+='<p class="memo">'+esc(it.memo)+'</p>';
    h+='<div class="acts"><button type="button" class="btn" data-act="done" data-id="'+id+'">'+(it.done?'완료 취소':'완료 처리')+'</button>'
      +'<button type="button" class="btn" data-act="edit" data-id="'+id+'">수정</button></div>';
    h+='</div><div class="stub"><span class="dd">'+big+'</span><span class="dt">'+fmtDate(it.deadline)+'</span></div></article>';
    return h;
  }
  function render(){
    var now=new Date();
    $('#today').textContent=(now.getMonth()+1)+'월 '+now.getDate()+'일 '+WD[now.getDay()]+'요일';
    var act=items.filter(function(i){return !i.done}), dn=items.length-act.length;
    var soon=act.filter(function(i){var n=daysLeft(i.deadline);return n>=0&&n<=7}).length;
    var late=act.filter(function(i){return daysLeft(i.deadline)<0}).length;
    $('#sum').textContent='진행 중 '+act.length+'건 · 7일 안에 마감 '+soon+'건'+(late?' · 기한 지남 '+late+'건':'');
    var sy=$('#sync');sy.className='sync';
    sy.textContent='이 브라우저에 저장돼요 · 아래 백업 저장으로 다른 기기에 옮길 수 있어요';
    $('#seg').innerHTML=[['active','진행중',act.length],['done','완료',dn],['all','전체',items.length]].map(function(r){
      return '<button type="button" data-f="'+r[0]+'" aria-pressed="'+(filter===r[0])+'">'+r[1]+' <b>'+r[2]+'</b></button>';
    }).join('');
    var used=platforms().filter(function(p){return items.some(function(i){return i.platform===p})});
    if(pf&&used.indexOf(pf)<0)pf='';
    var sel=$('#pf');
    sel.hidden=used.length<2;
    sel.innerHTML='<option value="">전체 플랫폼</option>'+used.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>'}).join('');
    sel.value=pf;
    var vis=items.filter(function(i){
      return (filter==='all'||(filter==='active'?!i.done:!!i.done))&&(!pf||i.platform===pf);
    }).sort(function(a,b){return ((+!!a.done)-(+!!b.done))||a.deadline.localeCompare(b.deadline)});
    var L=$('#list');
    if(!items.length)L.innerHTML='<div class="empty"><strong>아직 등록한 체험단이 없어요</strong>아래 추가 버튼으로 첫 체험단을 넣어보세요.</div>';
    else if(!vis.length)L.innerHTML='<div class="empty"><strong>조건에 맞는 체험단이 없어요</strong>필터를 바꿔 보세요.</div>';
    else L.innerHTML=vis.map(ticketHTML).join('');
  }

  /* ---------- 입력 시트 ---------- */
  function getVal(k){
    switch(k){
      case 'store':return $('#f-store').value.trim();
      case 'offer':return $('#f-offer').value.trim();
      case 'deadline':return $('#f-date').value;
      case 'phone':return $('#f-phone').value.trim();
      case 'platform':return customOpen?$('#f-custom').value.trim():formPlat;
      case 'keywords':return formKw.length?'x':'';
      case 'notice':return $('#f-notice').value.trim();
    }
    return '';
  }
  function paintMiss(){REQ.forEach(function(k){$('#w-'+k).classList.toggle('miss',miss.indexOf(k)>=0)})}
  function refreshMiss(){if(!miss.length)return;miss=miss.filter(function(k){return !getVal(k)});paintMiss()}
  function chipsHTML(sel,isCustom,addLabel){
    var h=platforms().map(function(p){
      return '<button type="button" class="chip" data-p="'+esc(p)+'" aria-pressed="'+(!isCustom&&sel===p)+'">'+esc(p)+'</button>';
    }).join('');
    if(addLabel)h+='<button type="button" class="chip add" data-custom="1" aria-pressed="'+isCustom+'">'+addLabel+'</button>';
    return h;
  }
  function renderChips(){$('#plats').innerHTML=chipsHTML(formPlat,customOpen,'+ 직접 입력');$('#f-custom').hidden=!customOpen}
  function renderKw(){
    $('#kwlist').innerHTML=formKw.map(function(k,i){
      return '<span class="kw">'+esc(k)+'<button type="button" data-rm="'+i+'" aria-label="'+esc(k)+' 삭제">✕</button></span>';
    }).join('');
  }
  function addKw(str){
    String(str||'').split(/[,\n#]+/).forEach(function(x){
      x=x.trim();if(x&&formKw.indexOf(x)<0&&formKw.length<30)formKw.push(x);
    });
    renderKw();
  }
  function renderPhotoBox(){
    var names=Object.keys(templates).filter(function(p){var t=templates[p];return t&&(t.offer||t.keywords||t.phone||t.notice)});
    $('#tplnote').textContent=names.length?'저장된 화면 형식: '+names.join(', '):'';
  }
  function renderImgs(){
    thumbUrls.forEach(function(u){URL.revokeObjectURL(u)});thumbUrls=[];
    var box=$('#imgs');
    if(!pendingImgs.length){box.hidden=true;$('#thumbs').innerHTML='';return}
    box.hidden=false;
    $('#thumbs').innerHTML=pendingImgs.map(function(b,i){
      var u=URL.createObjectURL(b);thumbUrls.push(u);
      return '<img src="'+u+'" alt="올린 사진 '+(i+1)+'" data-z="'+i+'">';
    }).join('');
  }
  function setStat(t,bad){var e=$('#stat');e.textContent=t||'';e.style.color=bad?'var(--urgent)':''}
  function saveDraft(){
    if(editing)return;
    lsSet(DRAFT,{store:$('#f-store').value,offer:$('#f-offer').value,deadline:$('#f-date').value,phone:$('#f-phone').value,
      notice:$('#f-notice').value,memo:$('#f-memo').value,platform:formPlat,customOpen:customOpen,custom:$('#f-custom').value,
      keywords:formKw,miss:miss});
  }
  function lockBody(on){document.body.style.overflow=on?'hidden':''}
  function openSheet(id){
    editing=id||null;
    var it=editing?items.find(function(i){return i.id===editing}):null;
    var d=it||lsGet(DRAFT,null)||{};
    $('#sh-title').textContent=it?'체험단 수정':'체험단 추가';
    $('#f-store').value=d.store||'';
    $('#f-offer').value=d.offer||'';
    $('#f-date').value=d.deadline||'';
    $('#f-phone').value=d.phone||'';
    $('#f-notice').value=d.notice||'';
    $('#f-memo').value=d.memo||'';
    $('#f-kw').value='';
    formPlat=d.platform||'';
    customOpen=!it&&!!d.customOpen;
    $('#f-custom').value=customOpen?(d.custom||''):'';
    formKw=(d.keywords||[]).slice();
    miss=(it?(it.fix||[]):(d.miss||[])).slice();
    pendingImgs=[];
    $('#err').textContent='';setStat('');
    var del=$('#del');del.hidden=!it;del.classList.remove('armed');del.textContent='삭제';
    renderChips();renderKw();renderPhotoBox();renderImgs();
    refreshMiss();paintMiss();
    $('#scrim').hidden=false;$('#sheet').hidden=false;lockBody(true);
    var key=editing||'draft', mine=editing;
    idbGet(key).then(function(v){
      if(editing!==mine||$('#sheet').hidden)return;
      if(v&&v.length){pendingImgs=v;renderImgs()}
      else if(miss.length){miss=[];paintMiss()}
    });
  }
  function closeSheet(){
    cancelled=true;
    $('#scrim').hidden=true;$('#sheet').hidden=true;$('#fmt').hidden=true;lockBody(false);editing=null;
    thumbUrls.forEach(function(u){URL.revokeObjectURL(u)});thumbUrls=[];
  }
  async function submit(e){
    e.preventDefault();
    var store=$('#f-store').value.trim(), date=$('#f-date').value, err=$('#err');
    if(!store){err.textContent='가게 이름을 입력해 주세요.';$('#f-store').focus();return}
    if(!date){err.textContent='마감일을 선택해 주세요.';$('#f-date').focus();return}
    if($('#f-kw').value.trim())addKw($('#f-kw').value);
    refreshMiss();
    var base={store:store,offer:$('#f-offer').value.trim(),deadline:date,phone:$('#f-phone').value.trim(),platform:getVal('platform'),
      keywords:formKw.slice(),notice:$('#f-notice').value.trim(),memo:$('#f-memo').value.trim()};
    var it;
    if(editing){it=items.find(function(i){return i.id===editing});Object.assign(it,base)}
    else{it=Object.assign({id:uid(),done:false,created:Date.now()},base);items.push(it);lsDel(DRAFT)}
    if(pendingImgs.length){it.hasImg=true;it.fix=miss.slice();await idbPut(it.id,pendingImgs)}
    else{it.hasImg=false;it.fix=[];idbDel(it.id)}
    if(!editing)idbDel('draft');
    saveItems();closeSheet();render();toast('저장했어요');
  }
  function deleteImgs(){
    var key=editing||'draft', it=editing?items.find(function(i){return i.id===editing}):null;
    pendingImgs=[];idbDel(key);renderImgs();
    miss=[];paintMiss();saveDraft();
    if(it){it.hasImg=false;it.fix=[];saveItems();render()}
    toast('사진을 지웠어요');
  }

  /* ---------- 사진 읽기(이 기기에서 OCR) ---------- */
  async function readPhotos(fileList){
    var files=Array.from(fileList||[]).filter(function(f){return /^image\//.test(f.type)});
    if(!files.length||busy)return;
    if(files.length>8){toast('한 번에 8장까지 읽을 수 있어요');files=files.slice(0,8)}
    if(!window.Tesseract){setStat('글자 인식 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.',true);$('#f-photo').value='';return}
    busy=true;cancelled=false;
    $('#photo-btn').disabled=true;$('#photo-stop').hidden=false;
    var keepKey=editing||'draft', texts=[], words=[];
    try{
      setStat('글자 인식 준비 중이에요. 처음 한 번은 한글 데이터를 내려받느라 1분 가까이 걸려요.');
      worker=await Tesseract.createWorker('kor+eng',1,{logger:function(m){
        if(m.status==='recognizing text')setStat('사진 읽는 중 '+Math.round(m.progress*100)+'%');
        else if(/loading/.test(m.status||''))setStat('한글 데이터 불러오는 중…');
      }});
      for(var i=0;i<files.length;i++){
        if(cancelled)throw {cancelled:true};
        setStat('사진 '+(i+1)+'/'+files.length+' 읽는 중');
        var r=await worker.recognize(files[i]);
        texts.push(r.data.text||'');
        (r.data.words||[]).forEach(function(w){words.push(w)});
      }
      if(cancelled)throw {cancelled:true};
      var res=parseOCR(texts.join('\n'),words);
      if(res.store&&!getVal('store'))$('#f-store').value=res.store;
      if(res.offer&&!getVal('offer'))$('#f-offer').value=res.offer;
      if(res.deadline&&!getVal('deadline'))$('#f-date').value=res.deadline;
      if(res.phone&&!getVal('phone'))$('#f-phone').value=res.phone;
      if(res.notice&&!getVal('notice'))$('#f-notice').value=res.notice;
      if(res.keywords)addKw(res.keywords.join(','));
      if(res.platform&&!getVal('platform')){formPlat=res.platform;customOpen=false;renderChips()}
      var pname=getVal('platform'), learned=false;
      if(pname){
        var T=templates[pname]||{};
        ['offer','keywords','phone','notice'].forEach(function(f){
          var lab=res.labels[f];
          if(lab){
            var list=String(T[f]||'').split(',').map(function(x){return x.trim()}).filter(Boolean);
            if(list.indexOf(lab)<0&&DEF[f].indexOf(lab)<0){list.push(lab);T[f]=list.join(', ');learned=true}
          }
        });
        if(learned){templates[pname]=T;lsSet(TPL,templates)}
        else if(!templates[pname]){templates[pname]=T;lsSet(TPL,templates)}
        renderPhotoBox();
      }
      miss=REQ.filter(function(k){return !getVal(k)});
      paintMiss();
      var tail=res.calendar?' 마감일은 달력 표시를 보고 추정했으니 한 번 확인해 주세요.':'';
      if(miss.length){
        pendingImgs=pendingImgs.concat(files).slice(0,8);
        await idbPut(keepKey,pendingImgs);renderImgs();
        setStat(miss.length+'개 항목을 못 읽었어요: '+miss.map(function(k){return FN[k]}).join(', ')+'. 사진을 보고 빨간 칸을 적어 주세요.'+tail,true);
      }else{
        pendingImgs=[];await idbDel(keepKey);renderImgs();
        setStat('모두 읽었어요. 사진은 지웠어요.'+tail);
      }
      saveDraft();
    }catch(e){
      if(e&&e.cancelled){setStat('읽기를 취소했어요.')}
      else{
        miss=REQ.filter(function(k){return !getVal(k)});paintMiss();
        pendingImgs=pendingImgs.concat(files).slice(0,8);
        await idbPut(keepKey,pendingImgs);renderImgs();
        setStat('사진을 읽다가 문제가 생겼어요. 직접 적어 주세요.',true);saveDraft();
      }
    }finally{
      busy=false;
      try{if(worker)await worker.terminate()}catch(x){}
      worker=null;
      $('#photo-btn').disabled=false;$('#photo-stop').hidden=true;$('#f-photo').value='';
    }
  }

  function copyText(t,msg){
    var ok=function(){toast(msg||'복사했어요')};
    var fb=function(){
      try{
        var ta=document.createElement('textarea');ta.value=t;ta.style.cssText='position:fixed;opacity:0';
        document.body.appendChild(ta);ta.select();var r=document.execCommand('copy');ta.remove();
        r?ok():toast('길게 눌러 복사해 주세요');
      }catch(e){toast('길게 눌러 복사해 주세요')}
    };
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(t).then(ok,fb)}else fb();
  }

  /* ---------- 인식 형식 편집 / 백업 ---------- */
  function renderFmt(){
    $('#fmt-plats').innerHTML=chipsHTML(fmtPlat,false,'');
    var T=templates[fmtPlat]||{};
    $('#fmt-fields').hidden=!fmtPlat;
    ['offer','keywords','phone','notice'].forEach(function(f){$('#fx-'+f).value=T[f]||''});
  }
  function openFmt(){
    fmtPlat=fmtPlat||'리뷰노트';renderFmt();
    $('#scrim').hidden=false;$('#fmt').hidden=false;lockBody(true);
  }
  function exportBackup(){
    var data=JSON.stringify({v:1,items:items,templates:templates},null,1);
    var a=document.createElement('a');
    a.href=URL.createObjectURL(new Blob([data],{type:'application/json'}));
    a.download='체험단일정-백업-'+ymd(new Date())+'.json';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(a.href)},2000);
    toast('백업 파일을 저장했어요');
  }
  function importBackup(file){
    if(!file)return;
    var r=new FileReader();
    r.onload=function(){
      try{
        var d=JSON.parse(r.result);
        if(!d||!Array.isArray(d.items))throw 0;
        var have={};items.forEach(function(i){have[i.id]=1});
        var add=d.items.filter(function(i){return i&&i.id&&i.store&&i.deadline&&!have[i.id]});
        items=items.concat(add);
        if(d.templates&&typeof d.templates==='object')templates=Object.assign({},d.templates,templates);
        saveItems();lsSet(TPL,templates);render();
        toast(add.length+'건을 불러왔어요');
      }catch(e){toast('백업 파일을 읽을 수 없어요')}
      $('#f-imp').value='';
    };
    r.readAsText(file);
  }

  /* ---------- 이벤트 ---------- */
  $('#list').addEventListener('click',function(e){
    var b=e.target.closest('[data-act]');if(!b)return;
    var it=items.find(function(i){return i.id===b.dataset.id});if(!it)return;
    var a=b.dataset.act;
    if(a==='edit')openSheet(it.id);
    else if(a==='copy')copyText(it.phone,'번호를 복사했어요');
    else if(a==='copykw')copyText((it.keywords||[]).join(', '),'키워드를 복사했어요');
    else if(a==='done'){it.done=!it.done;saveItems();render();toast(it.done?'완료 처리했어요':'진행 중으로 되돌렸어요')}
  });
  $('#seg').addEventListener('click',function(e){var b=e.target.closest('[data-f]');if(b){filter=b.dataset.f;render()}});
  $('#pf').addEventListener('change',function(e){pf=e.target.value;render()});
  $('#add').addEventListener('click',function(){openSheet()});
  $('#close').addEventListener('click',closeSheet);
  $('#fmt-close').addEventListener('click',closeSheet);
  $('#scrim').addEventListener('click',closeSheet);
  $('#sheet').addEventListener('submit',submit);
  $('#sheet').addEventListener('input',function(){saveDraft();refreshMiss()});
  $('#f-phone').addEventListener('input',function(e){e.target.value=fmtPhone(e.target.value)});
  $('#plats').addEventListener('click',function(e){
    var b=e.target.closest('button');if(!b)return;
    if(b.dataset.custom){customOpen=!customOpen;if(customOpen)formPlat='';renderChips();if(customOpen)$('#f-custom').focus()}
    else{customOpen=false;formPlat=(formPlat===b.dataset.p)?'':b.dataset.p;renderChips()}
    saveDraft();refreshMiss();
  });
  $('#kw-add').addEventListener('click',function(){addKw($('#f-kw').value);$('#f-kw').value='';saveDraft();refreshMiss()});
  $('#f-kw').addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();addKw(e.target.value);e.target.value='';saveDraft();refreshMiss()}
  });
  $('#kwlist').addEventListener('click',function(e){
    var b=e.target.closest('[data-rm]');if(!b)return;
    formKw.splice(+b.dataset.rm,1);renderKw();saveDraft();
  });
  $('#photo-btn').addEventListener('click',function(){$('#f-photo').click()});
  $('#f-photo').addEventListener('change',function(e){readPhotos(e.target.files)});
  $('#photo-stop').addEventListener('click',function(){cancelled=true;if(worker){try{worker.terminate()}catch(x){}}});
  $('#imgs-del').addEventListener('click',deleteImgs);
  $('#thumbs').addEventListener('click',function(e){
    var im=e.target.closest('[data-z]');if(!im)return;
    $('#zoom-img').src=im.src;$('#zoom').hidden=false;
  });
  $('#zoom').addEventListener('click',function(){$('#zoom').hidden=true;$('#zoom-img').removeAttribute('src')});
  $('#del').addEventListener('click',function(){
    var b=$('#del');
    if(!b.classList.contains('armed')){
      b.classList.add('armed');b.textContent='한 번 더 누르면 삭제';
      clearTimeout(delTimer);delTimer=setTimeout(function(){b.classList.remove('armed');b.textContent='삭제'},3000);
    }else{var id=editing;closeSheet();removeItem(id);toast('삭제했어요')}
  });
  $('#t-fmt').addEventListener('click',openFmt);
  $('#t-exp').addEventListener('click',exportBackup);
  $('#t-imp').addEventListener('click',function(){$('#f-imp').click()});
  $('#f-imp').addEventListener('change',function(e){importBackup(e.target.files[0])});
  $('#fmt-plats').addEventListener('click',function(e){
    var b=e.target.closest('[data-p]');if(!b)return;fmtPlat=b.dataset.p;renderFmt();
  });
  $('#fmt').addEventListener('submit',function(e){
    e.preventDefault();
    if(!fmtPlat)return;
    var T={};
    ['offer','keywords','phone','notice'].forEach(function(f){T[f]=$('#fx-'+f).value.trim()});
    templates[fmtPlat]=T;lsSet(TPL,templates);renderPhotoBox();
    closeSheet();toast(fmtPlat+' 형식을 저장했어요');
  });
  document.addEventListener('keydown',function(e){
    if(e.key!=='Escape')return;
    if(!$('#zoom').hidden)$('#zoom').hidden=true;
    else if(!$('#sheet').hidden||!$('#fmt').hidden)closeSheet();
  });
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')render()});

  items=lsGet(LS,[]);
  templates=lsGet(TPL,{});
  render();
  if('serviceWorker' in navigator&&location.protocol.indexOf('http')===0){
    var reloading=false;
    navigator.serviceWorker.addEventListener('controllerchange',function(){
      if(reloading)return;reloading=true;location.reload();
    });
    navigator.serviceWorker.register('sw.js').then(function(reg){
      function offer(w){
        if(!w||!navigator.serviceWorker.controller)return;
        $('#upd').hidden=false;
        $('#upd-btn').onclick=function(){$('#upd-btn').disabled=true;$('#upd-btn').textContent='업데이트 중…';w.postMessage('skip')};
      }
      if(reg.waiting)offer(reg.waiting);
      reg.addEventListener('updatefound',function(){
        var w=reg.installing;
        if(w)w.addEventListener('statechange',function(){if(w.state==='installed')offer(w)});
      });
      var check=function(){reg.update().catch(function(){})};
      setInterval(check,30*60*1000);
      document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')check()});
    }).catch(function(){});
  }
  window.__chexdan={parseOCR:parseOCR};
})();
