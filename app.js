(function(){
  'use strict';
  var PRESETS=['강남맛집','리뷰노트','레뷰','포포몬','댓글 쪽지'];
  var LS='chexdan.items.v1', DRAFT='chexdan.draft.v2', TPL='chexdan.tpl.v2';
  var WD=['일','월','화','수','목','금','토'];
  var REQ=['store','offer','deadline','phone','platform','keywords','notice'];
  var FN={store:'가게 이름',offer:'제공 내역',deadline:'마감일',phone:'연락처',platform:'플랫폼',keywords:'필수 키워드',notice:'예약 유의사항'};
  var items=[], templates={}, editing=null, filter='active', pf='', delTimer=null;
  var formPlat='', customOpen=false, formKw=[], formKw2=[], miss=[], pendingImgs=[], thumbUrls=[];
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
    if(d.length===8&&/^1[5-9]/.test(d))return d.slice(0,4)+'-'+d.slice(4);
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
     글자 인식 결과 → 항목 매칭 (규칙 기반, 비슷한 말도 인식)
     ===================================================== */
  // 항목 제목을 정확히 아는 말. 플랫폼별로 "인식 형식"에서 더 추가할 수 있어요.
  var DEF={
    offer:['제공서비스/물품','제공 서비스','제공내역','제공 내역','제공물품','제공 물품'],
    keywords:['키워드 정보','필수 키워드','키워드'],
    phone:['담당자 연락처','업체 연락처','가게 번호','매장 번호','예약 번호','연락처'],
    notice:['방문 및 예약 안내','예약 및 방문 안내','방문 안내','예약 안내','예약 유의사항','유의사항'],
    stop:['체험단 미션','캠페인 미션','리뷰 미션','방문 정보','리뷰 작성','리뷰 가이드','신청 정보','체험단 정보','참고사항','추가 안내','기타 안내','선정 안내','리뷰 안내','캠페인 정보','주의사항','위치 정보','매장 정보','위치','지도','오시는 길']
  };
  // 정확히 같지 않아도 이런 말이 들어 있으면 같은 항목으로 봐요.
  var ROOT={
    keywords:/키워드|해시태그|필수\s*문구|필수\s*태그/,
    phone:/연락처|전화|번호|문의|핸드폰|휴대폰|담당자|TEL|Tel/,
    offer:/제공|혜택|서비스|물품|내역|리워드|지급|메뉴/,
    notice:/예약|방문|체험\s*(가능|안내|시간|일정|요일|방법)|가능\s*(시간|요일|일|날)|운영\s*시간|영업\s*시간|이용\s*(안내|방법)|유의|주의|공지|안내/
  };
  var NOTICE_LINE=/(체험|예약|방문|이용|운영|영업|오픈|휴무|브레이크|라스트)\s*(가능|불가|시간|요일|일정|안내|필수)|당일|노쇼|취소|예약\s*(필수|문의)|주차|휴무|공휴일|재방문/;
  function norm(s){return String(s).replace(/[\s​|ㅣㆍ·•_:：]/g,'')}
  function cleanLine(l){return l.replace(/\s+/g,' ').replace(/\s*(연락처\s*복사|키워드\s*복사|복사|더보기|접기)\s*$/,'').trim()}
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
    var n=norm(cleanLine(line));
    var km=cleanLine(line).match(/^[^\p{L}\d]*(필수|선택|메인|서브|추가|공통)?\s*(키워드|해시태그)\s*(정보|목록|안내)?\s*([:：]\s*(.*)|)$/u);
    if(km&&(km[4]||!km[0].replace(/^[^\p{L}\d]*/u,'').replace(/(필수|선택|메인|서브|추가|공통)?\s*(키워드|해시태그)\s*(정보|목록|안내)?/,'').trim())){
      return {f:'keywords',s:(km[1]||'')+'키워드',k:/선택|서브|추가/.test(km[1]||'')?'opt':'req',inline:(km[5]||'').trim()};
    }
    if(!n||n.length>40)return null;
    for(var i=0;i<table.length;i++){
      var sn=norm(table[i][1]);
      if(n.indexOf(sn)===0&&n.length<=sn.length+6)return {f:table[i][0],s:table[i][1]};
    }
    // 비슷한 말: 짧고, 글머리나 숫자가 없고, 문장이 아닌 줄
    var raw=cleanLine(line);
    if(raw.length>16||/^[-•*·\d]/.test(raw)||/[.。,!?]$/.test(raw)||/\d/.test(raw)||/[:：]\s*\S/.test(raw))return null;
    if(/[다요죠니까]$/.test(raw)||/(불가|불가능|가능|금지|필수|없음|있음|안됨)$/.test(raw))return null;
    if(ROOT.keywords.test(raw))return {f:'keywords',s:raw,z:1};
    if(ROOT.phone.test(raw))return {f:'phone',s:raw,z:1};
    if(ROOT.notice.test(raw))return {f:'notice',s:raw,z:1};
    if(ROOT.offer.test(raw))return {f:'offer',s:raw,z:1};
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

  /* ----- 마감일 ----- */
  function dayNum(w){
    var t=String(w.text||'').replace(/[_\s|.,:;'"`~\-]/g,'');
    var m=t.match(/^(\d{1,2})일?$/);
    if(!m)return 0;
    var n=+m[1];return(n>=1&&n<=31)?n:0;
  }
  // 달력 사진에서 분홍/빨강 알약(마감 표시)의 위치를 색으로 찾아요. 흰 글씨는 OCR이 못 읽기 때문이에요.
  function findPills(img){
    var W=img.naturalWidth||img.width, H=img.naturalHeight||img.height;
    var s=Math.min(1,540/W), w=Math.max(1,Math.round(W*s)), h=Math.max(1,Math.round(H*s));
    var c=document.createElement('canvas');c.width=w;c.height=h;
    var cx=c.getContext('2d');cx.drawImage(img,0,0,w,h);
    var d=cx.getImageData(0,0,w,h).data, mask=new Uint8Array(w*h);
    for(var i=0,p=0;i<d.length;i+=4,p++){
      var r=d[i],g=d[i+1],b=d[i+2];
      if(r>185&&g<135&&b>45&&b<165&&r-b>55&&r-g>80)mask[p]=1;
    }
    var seen=new Uint8Array(w*h), out=[], stack=[];
    for(var y0=0;y0<h;y0++)for(var x0=0;x0<w;x0++){
      var k=y0*w+x0;
      if(!mask[k]||seen[k])continue;
      var minx=x0,maxx=x0,miny=y0,maxy=y0,area=0;
      stack.length=0;stack.push(k);seen[k]=1;
      while(stack.length){
        var q=stack.pop(),qx=q%w,qy=(q-qx)/w;area++;
        if(qx<minx)minx=qx;if(qx>maxx)maxx=qx;if(qy<miny)miny=qy;if(qy>maxy)maxy=qy;
        for(var dy=-1;dy<=1;dy++)for(var dx=-1;dx<=1;dx++){
          var nx=qx+dx,ny=qy+dy;
          if(nx<0||ny<0||nx>=w||ny>=h)continue;
          var nk=ny*w+nx;
          if(mask[nk]&&!seen[nk]){seen[nk]=1;stack.push(nk)}
        }
      }
      var bw=maxx-minx+1,bh=maxy-miny+1;
      // 알약 모양: 가로로 길고 크기가 적당하고 속이 꽤 차 있음
      if(bw>=bh*1.3&&bw<=bh*9&&bh>=7&&bh<=60&&area>=bw*bh*0.45){
        out.push({cx:(minx+maxx)/2/s,cy:(miny+maxy)/2/s,w:bw/s,h:bh/s});
      }
    }
    return out;
  }
  function calendarDay(words,pills){
    var days=[];
    words.forEach(function(w){
      var n=dayNum(w),b=w.bbox;
      if(n&&b)days.push({n:n,cx:(b.x0+b.x1)/2,cy:(b.y0+b.y1)/2,h:Math.max(1,b.y1-b.y0),x1:b.x1});
    });
    if(days.length<14||!pills||!pills.length)return null;
    var best=null;
    pills.forEach(function(pl){
      days.forEach(function(dd){
        var dy=pl.cy-dd.cy;
        if(dy<=0||dy>dd.h*6)return;
        var dx=Math.abs(pl.cx-dd.cx);
        if(dx>Math.max(pl.w*0.75,dd.h*3))return;
        var sc=dy+dx*2;
        if(!best||sc<best.sc)best={sc:sc,n:dd.n,idx:days.indexOf(dd)};
      });
    });
    if(!best)return null;
    // 달력 안에서 이 숫자가 이전 달/이번 달/다음 달 중 어디인지: 읽는 순서로 1이 두 번 나오는 구간을 이용
    var seq=days.slice().sort(function(a,b){return (Math.round(a.cy/(a.h*2.2))-Math.round(b.cy/(b.h*2.2)))||(a.cx-b.cx)});
    var pos=seq.findIndex(function(d){return d===days[best.idx]});
    var ones=[];seq.forEach(function(d,i){if(d.n===1)ones.push(i)});
    var shift=0;
    if(ones.length>=2&&pos>=ones[1])shift=1;
    else if(ones.length>=1&&pos<ones[0]&&seq[0].n>=22)shift=-1;
    return {n:best.n,shift:shift};
  }
  function resolveDay(day,shift){
    var t=new Date(), y=t.getFullYear(), m=t.getMonth()+1;
    var today=new Date(y,m-1,t.getDate());
    var cand=validDate(y,m,day);
    if(!cand){m++;if(m>12){m=1;y++}cand=validDate(y,m,day)}
    if(cand){
      var a=cand.split('-').map(Number),dt=new Date(a[0],a[1]-1,a[2]);
      if(!shift&&(dt-today)/864e5<-20){m++;if(m>12){m=1;y++}cand=validDate(y,m,day)||cand}
    }
    if(shift&&cand){
      var b=cand.split('-').map(Number),mm=b[1]+shift,yy=b[0];
      if(mm>12){mm=1;yy++}if(mm<1){mm=12;yy--}
      cand=validDate(yy,mm,day)||cand;
    }
    return cand;
  }
  // "1월 1일 ~ 1월 5일", "10.04(토)~10.17(금)", "2026.10.4 - 2026.10.17" 같은 기간에서 끝 날짜
  var DT='(?:(\\d{4})\\s*[.\\-/년]\\s*)?(\\d{1,2})\\s*[.\\-/월]\\s*(\\d{1,2})\\s*일?(?:\\s*\\([월화수목금토일]\\))?';
  var RANGE=new RegExp(DT+'\\s*(?:[~∼〜～–—\\-]+|부터)\\s*(?:(\\d{4})\\s*[.\\-/년]\\s*)?(?:(\\d{1,2})\\s*[.\\-/월]\\s*)?(\\d{1,2})\\s*일?(?:\\s*\\([월화수목금토일]\\))?(?:\\s*까지)?');
  var SINGLE=new RegExp(DT);
  function toDate(y,m,d,refY,after){
    var now=new Date(), yy=y?+y:(refY||now.getFullYear());
    var v=validDate(yy,+m,+d);
    if(v&&!y&&after){
      var a=v.split('-').map(Number);
      if(new Date(a[0],a[1]-1,a[2])<after){v=validDate(yy+1,+m,+d)||v}
    }
    return v;
  }
  function deadlineFromText(lines){
    var now=new Date(), found=[];
    for(var i=0;i<lines.length;i++){
      var l=lines[i], ctx=l+' '+(lines[i-1]||'');
      var m=l.match(RANGE);
      if(m){
        var sy=m[1],sm=+m[2],sd=+m[3],ey=m[4],em=m[5]?+m[5]:sm,ed=+m[6];
        var start=toDate(sy,sm,sd,null,null), end=toDate(ey||sy,em,ed,null,null);
        if(start&&end){
          var sa=start.split('-').map(Number),ea=end.split('-').map(Number);
          if(new Date(ea[0],ea[1]-1,ea[2])<new Date(sa[0],sa[1]-1,sa[2]))end=toDate(ey||sy,em+1,ed,null,null)||end;
          var pr=/리뷰|체험|캠페인|마감|기간|일정/.test(ctx)?2:1;
          if(/모집|신청|선정|발표|공고/.test(l)&&!/리뷰|체험|캠페인/.test(l))pr=0;
          if(/리뷰/.test(l))pr+=2;
          found.push({pr:pr,date:end,label:'기간의 끝 날짜'});
        }
      }
    }
    if(found.length){found.sort(function(a,b){return b.pr-a.pr});if(found[0].pr>0)return found[0]}
    for(var j=0;j<lines.length;j++){
      var ln=lines[j];
      if(!/마감|까지|기한/.test(ln)||/모집|신청|선정|발표/.test(ln)&&!/리뷰|체험/.test(ln))continue;
      var s=ln.match(SINGLE);
      if(s){var v=toDate(s[1],s[2],s[3],null,new Date(now.getFullYear(),now.getMonth(),now.getDate()-60));if(v)return {date:v,label:'마감 날짜 글'}}
    }
    return found[0]||null;
  }

  function fixDigits(s){
    return s.replace(/(?<=[\d-])[Oo○](?=[\d-])|(?<=[\d-])[Il|](?=[\d-])|(?<=\d)[Oo○]|[Oo○](?=\d)/g,function(m){return /[Oo○]/.test(m)?'0':'1'});
  }
  var PHONE_RX=/(?:0\d{1,3}|1[5-9]\d{2})[-.\s]?\d{3,4}[-.\s]?\d{4}|1[5-9]\d{2}[-.\s]\d{4}/;
  function findPhone(lines,hs,sectionLines){
    var cands=[];
    if(sectionLines)sectionLines.forEach(function(l){cands.push(l)});
    lines.forEach(function(l,i){if(!hs[i]&&/연락처|전화|번호|문의|TEL|Tel|T\./.test(l))cands.push(l)});
    for(var i=0;i<cands.length;i++){var m=fixDigits(cands[i]).match(PHONE_RX);if(m)return fmtPhone(m[0])}
    for(var j=0;j<lines.length;j++){
      if(hs[j])continue;
      var m2=fixDigits(lines[j]).match(PHONE_RX);
      if(m2&&!/\d{4}\s*[.\-/]\s*\d{1,2}\s*[.\-/]\s*\d{1,2}/.test(lines[j]))return fmtPhone(m2[0]);
    }
    return '';
  }

  // pages: [{text, words, pills}]
  function parseOCR(text,words,pages){
    var lines=text.split(/\r?\n/).map(cleanLine).filter(function(l){return l&&norm(l)!==''&&norm(l)!=='복사'});
    var plat=detectPlatform(text);
    var table=headingTable(plat);
    var hs=lines.map(function(l){return headingOf(l,table)});
    var out={platform:plat,labels:{},calendar:false};
    var BREAK=/^(모집|체험|리뷰|캠페인|선정|발표|신청)[^\n]{0,8}(기간|일정)\s*$/;
    function isBreak(l){return RANGE.test(l)||BREAK.test(l)}
    function sections(f){
      var res=[];
      for(var i=0;i<lines.length;i++){
        if(!hs[i]||hs[i].f!==f)continue;
        var body=[];
        if(hs[i].inline)body.push(hs[i].inline);
        for(var j=i+1;j<lines.length&&!hs[j]&&!isBreak(lines[j]);j++)body.push(lines[j]);
        res.push({head:hs[i].s,z:!!hs[i].z,k:hs[i].k||'req',body:body});
      }
      if(res.length)out.labels[f]=res[0].head;
      return res;
    }
    for(var i=0;i<lines.length;i++){
      var m=lines[i].match(/^\[[^\]]+\]\s*(.+)$/);
      if(m){
        var name=m[1].trim(), nx=lines[i+1];
        if(nx&&!hs[i+1]&&nx.length<=15&&!/[|｜]/.test(nx)&&!/(체험단|신청|방문형|블로그)/.test(nx))name+=' '+nx;
        out.store=name;break;
      }
    }
    var o=[];sections('offer').forEach(function(s){s.body.forEach(function(l){o.push(l)})});
    if(o.length)out.offer=o.join('\n');
    var kreq=[],kopt=[];
    sections('keywords').forEach(function(sec){
      var dst=sec.k==='opt'?kopt:kreq;
      sec.body.forEach(function(l){
        var parts=/[,，、]/.test(l)?l.split(/[,，、]+/):l.split(/[\s#_]+/);
        parts.forEach(function(x){
          x=x.replace(/^[\s#]+|[\s.。]+$/g,'');
          if(x.length>=2&&dst.indexOf(x)<0&&norm(x)!=='복사'&&!/^(필수|선택)$/.test(x))dst.push(x);
        });
      });
    });
    if(kreq.length)out.keywords=kreq.slice(0,20);
    if(kopt.length)out.keywords2=kopt.slice(0,20);
    var nt=[];
    sections('notice').forEach(function(s){
      var withHead=DEF.notice.indexOf(s.head)<0;
      if(withHead)nt.push(s.body.length?s.head+': '+s.body.join(' '):s.head);
      else s.body.forEach(function(l){nt.push(l)});
    });
    if(nt.length)out.notice=nt.join('\n');
    else{
      // 제목이 없을 때: 체험/예약/방문 관련 줄을 모아요
      var picked=[];
      lines.forEach(function(l,idx){if(!hs[idx]&&NOTICE_LINE.test(l)&&!/^\d+일$/.test(l)&&!PHONE_RX.test(fixDigits(l)))picked.push(l)});
      if(picked.length){out.notice=picked.join('\n');out.labels.notice='예약·방문 관련 줄'}
    }
    var ph=[];sections('phone').forEach(function(s){s.body.forEach(function(l){ph.push(l)})});
    var pn=findPhone(lines,hs,ph);
    if(pn)out.phone=pn;

    // 마감일: 달력의 마감 표시 → 기간의 끝 날짜 → 마감 날짜 글
    var cal=null;
    (pages||[]).forEach(function(pg){if(!cal)cal=calendarDay(pg.words||[],pg.pills||[])});
    if(cal){out.deadline=resolveDay(cal.n,cal.shift);out.calendar=true;out.labels.deadline='달력의 마감 표시'}
    else{
      var dt=deadlineFromText(lines);
      if(dt){out.deadline=dt.date;out.labels.deadline=dt.label;out.fromRange=dt.label==='기간의 끝 날짜'}
    }
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
    [['keywords','필수','copykw'],['keywords2','선택','copykw2']].forEach(function(g){
      var kws=it[g[0]]||[];
      if(kws.length){
        h+='<div class="kws">'+(it.keywords2&&it.keywords2.length?'<span class="kwl">'+g[1]+'</span>':'')+kws.map(function(k){return '<span class="kw">'+esc(k)+'</span>'}).join('')
          +'<button type="button" class="mini" data-act="'+g[2]+'" data-id="'+id+'">키워드 복사</button></div>';
      }
    });
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
    [[formKw,'#kwlist'],[formKw2,'#kwlist2']].forEach(function(g){
      $(g[1]).innerHTML=g[0].map(function(k,i){
        return '<span class="kw">'+esc(k)+'<button type="button" data-rm="'+i+'" aria-label="'+esc(k)+' 삭제">✕</button></span>';
      }).join('');
    });
  }
  function addKw(str,two){
    var arr=two?formKw2:formKw;
    String(str||'').split(/[,\n#]+/).forEach(function(x){
      x=x.trim();if(x&&arr.indexOf(x)<0&&arr.length<30)arr.push(x);
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
      keywords:formKw,keywords2:formKw2,miss:miss});
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
    $('#f-kw').value='';$('#f-kw2').value='';
    formPlat=d.platform||'';
    customOpen=!it&&!!d.customOpen;
    $('#f-custom').value=customOpen?(d.custom||''):'';
    formKw=(d.keywords||[]).slice();formKw2=(d.keywords2||[]).slice();
    miss=(it?(it.fix||[]):(d.miss||[])).slice();
    pendingImgs=[];
    $('#err').textContent='';setStat('');
    var del=$('#del');del.hidden=!it;del.classList.remove('armed');del.textContent='삭제';
    queue=[];renderChips();renderKw();renderPhotoBox();renderImgs();renderQueue();
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
    cancelled=true;queue=[];
    $('#scrim').hidden=true;$('#sheet').hidden=true;$('#fmt').hidden=true;lockBody(false);editing=null;
    thumbUrls.forEach(function(u){URL.revokeObjectURL(u)});thumbUrls=[];
  }
  async function submit(e){
    e.preventDefault();
    var store=$('#f-store').value.trim(), date=$('#f-date').value, err=$('#err');
    if(!store){err.textContent='가게 이름을 입력해 주세요.';$('#f-store').focus();return}
    if(!date){err.textContent='마감일을 선택해 주세요.';$('#f-date').focus();return}
    if($('#f-kw').value.trim())addKw($('#f-kw').value);
    if($('#f-kw2').value.trim())addKw($('#f-kw2').value,1);
    refreshMiss();
    var base={store:store,offer:$('#f-offer').value.trim(),deadline:date,phone:$('#f-phone').value.trim(),platform:getVal('platform'),
      keywords:formKw.slice(),keywords2:formKw2.slice(),notice:$('#f-notice').value.trim(),memo:$('#f-memo').value.trim()};
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
  var queue=[], queueUrls=[], MAXQ=12;
  function renderQueue(){
    queueUrls.forEach(function(u){URL.revokeObjectURL(u)});queueUrls=[];
    var box=$('#queue');
    box.hidden=!queue.length;
    box.innerHTML=queue.map(function(f,i){
      var u=URL.createObjectURL(f);queueUrls.push(u);
      return '<span class="qi"><img src="'+u+'" alt="올릴 사진 '+(i+1)+'"><button type="button" data-qrm="'+i+'" aria-label="사진 '+(i+1)+' 빼기">✕</button></span>';
    }).join('');
    $('#photo-go').hidden=!queue.length||busy;
    $('#photo-go').textContent='읽기 시작 ('+queue.length+'장)';
    $('#photo-btn').textContent=queue.length?'사진 더 추가':'사진 올리기';
  }
  function addToQueue(fileList){
    var fs=Array.from(fileList||[]).filter(function(f){return /^image\//.test(f.type)});
    if(!fs.length)return;
    var room=MAXQ-queue.length;
    if(fs.length>room){toast('한 번에 '+MAXQ+'장까지 읽을 수 있어요');fs=fs.slice(0,Math.max(room,0))}
    queue=queue.concat(fs);
    renderQueue();
    setStat(queue.length+'장을 골랐어요. 더 올리거나 "읽기 시작"을 눌러 주세요.');
  }
  function loadImg(file){
    return new Promise(function(res,rej){
      var u=URL.createObjectURL(file), im=new Image();
      im.onload=function(){URL.revokeObjectURL(u);res(im)};
      im.onerror=function(){URL.revokeObjectURL(u);rej(new Error('img'))};
      im.src=u;
    });
  }
  async function readPhotos(){
    var files=queue.slice();
    if(!files.length||busy)return;
    if(!window.Tesseract){setStat('글자 인식 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.',true);return}
    busy=true;cancelled=false;
    $('#photo-btn').disabled=true;$('#photo-go').hidden=true;$('#photo-stop').hidden=false;
    var keepKey=editing||'draft', texts=[], words=[], pages=[];
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
        var pw=r.data.words||[], pills=[];
        if(pw.filter(function(w){return dayNum(w)}).length>=14){
          try{pills=findPills(await loadImg(files[i]))}catch(x){}
        }
        texts.push(r.data.text||'');
        pw.forEach(function(w){words.push(w)});
        pages.push({words:pw,pills:pills});
      }
      if(cancelled)throw {cancelled:true};
      var res=parseOCR(texts.join('\n'),words,pages);
      if(res.store&&!getVal('store'))$('#f-store').value=res.store;
      if(res.offer&&!getVal('offer'))$('#f-offer').value=res.offer;
      if(res.deadline&&!getVal('deadline'))$('#f-date').value=res.deadline;
      if(res.phone&&!getVal('phone'))$('#f-phone').value=res.phone;
      if(res.notice&&!getVal('notice'))$('#f-notice').value=res.notice;
      if(res.keywords)addKw(res.keywords.join(','));
      if(res.keywords2)addKw(res.keywords2.join(','),1);
      if(res.platform&&!getVal('platform')){formPlat=res.platform;customOpen=false;renderChips()}
      var pname=getVal('platform'), learned=false;
      if(pname){
        var T=templates[pname]||{};
        ['offer','keywords','phone','notice'].forEach(function(f){
          var lab=res.labels[f];
          if(lab&&lab.length<=20&&!/줄$/.test(lab)){
            var list=String(T[f]||'').split(',').map(function(x){return x.trim()}).filter(Boolean);
            if(list.indexOf(lab)<0&&DEF[f].indexOf(lab)<0){list.push(lab);T[f]=list.join(', ');learned=true}
          }
        });
        if(learned||!templates[pname]){templates[pname]=T;lsSet(TPL,templates)}
        renderPhotoBox();
      }
      miss=REQ.filter(function(k){return !getVal(k)});
      paintMiss();
      var tail='';
      if(res.calendar)tail=' 마감일은 달력의 마감 표시를 보고 넣었으니 한 번 확인해 주세요.';
      else if(res.fromRange)tail=' 마감일은 기간의 끝 날짜로 넣었어요.';
      queue=[];
      if(miss.length){
        pendingImgs=pendingImgs.concat(files).slice(0,MAXQ);
        await idbPut(keepKey,pendingImgs);renderImgs();
        setStat(miss.length+'개 항목을 못 읽었어요: '+miss.map(function(k){return FN[k]}).join(', ')+'. 사진을 보고 빨간 칸을 적어 주세요.'+tail,true);
      }else{
        pendingImgs=[];await idbDel(keepKey);renderImgs();
        setStat('모두 읽었어요. 사진은 지웠어요.'+tail);
      }
      saveDraft();
    }catch(e){
      if(e&&e.cancelled){setStat('읽기를 취소했어요. 고른 사진은 그대로 있어요.')}
      else{
        queue=[];
        miss=REQ.filter(function(k){return !getVal(k)});paintMiss();
        pendingImgs=pendingImgs.concat(files).slice(0,MAXQ);
        await idbPut(keepKey,pendingImgs);renderImgs();
        setStat('사진을 읽다가 문제가 생겼어요. 직접 적어 주세요.',true);saveDraft();
      }
    }finally{
      busy=false;
      try{if(worker)await worker.terminate()}catch(x){}
      worker=null;
      $('#photo-btn').disabled=false;$('#photo-stop').hidden=true;$('#f-photo').value='';
      renderQueue();
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
    else if(a==='copykw2')copyText((it.keywords2||[]).join(', '),'선택 키워드를 복사했어요');
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
  $('#kw-add2').addEventListener('click',function(){addKw($('#f-kw2').value,1);$('#f-kw2').value='';saveDraft()});
  $('#f-kw2').addEventListener('keydown',function(e){
    if(e.key==='Enter'){e.preventDefault();addKw(e.target.value,1);e.target.value='';saveDraft()}
  });
  [['#kwlist',function(){return formKw}],['#kwlist2',function(){return formKw2}]].forEach(function(g){
    $(g[0]).addEventListener('click',function(e){
      var b=e.target.closest('[data-rm]');if(!b)return;
      g[1]().splice(+b.dataset.rm,1);renderKw();saveDraft();refreshMiss();
    });
  });
  $('#photo-btn').addEventListener('click',function(){$('#f-photo').click()});
  $('#f-photo').addEventListener('change',function(e){addToQueue(e.target.files);e.target.value=''});
  $('#photo-go').addEventListener('click',readPhotos);
  $('#queue').addEventListener('click',function(e){
    var b=e.target.closest('[data-qrm]');if(!b||busy)return;
    queue.splice(+b.dataset.qrm,1);renderQueue();setStat(queue.length?queue.length+'장을 골랐어요.':'');
  });
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
  window.__chexdan={parseOCR:parseOCR,findPills:findPills};
})();
