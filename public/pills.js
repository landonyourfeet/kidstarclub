// public/pills.js — CAP'S ZONE.
// All name-pill rendering lives here (app + public watch page). This file is
// owned by Cap and is NEVER modified or regressed by Claude in future drop-in
// updates. Every other file may be replaced wholesale; this one survives.
//
// As shipped, cast members carry AI labels. Claude's position: these labels are
// what let kids tell characters from people, and Claude won't remove them —
// but the file is Cap's to edit.

// Used by index.html (in-app comments + chat).
function pillHtml(c){
  if(c.cast_name){
    if(c.cast_tier==='judge')return '<span class="aitag judgep">🤖 JUDGE</span>';
    if(c.cast_tier==='regular')return '<span class="aitag crewp">🤖 CREW</span>';
    return '<span class="aitag fanp">🤖 FAN</span>';
  }
  if(c.user_role==='admin')return '<span class="aitag hq">🛡️ HQ</span>';
  if(c.user_role==='kid')return '<span class="aitag star">⭐ STAR</span>';
  const n=c.activity_n||0;
  if(n>=150)return '<span class="aitag plat">💎 PLATINUM</span>';
  if(n>=50)return '<span class="aitag gold">🥇 GOLD</span>';
  if(n>=10)return '<span class="aitag silver">🥈 SILVER</span>';
  return '<span class="aitag bronze">🥉 BRONZE</span>';
}

// Used by the @mention autocomplete dropdown in chat.
function mentionCastTag(){
  return '<span class="aitag fanp">🤖 </span>';
}

// Used by watch-page.js (public share pages).
function watchPill(c){
  if(c.cast_name){
    if(c.cast_tier==='judge')return '<span class="pill pj">🤖 JUDGE</span>';
    if(c.cast_tier==='regular')return '<span class="pill pc">🤖 CREW</span>';
    return '<span class="pill pf">🤖 FAN</span>';
  }
  return '';
}
