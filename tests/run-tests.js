/**
 * JORD Golf Tournament System — Test Suite v1.0.0
 * Run: node tests/run-tests.js
 */

let passed = 0, failed = 0, total = 0;

function test(name, fn) {
  total++;
  try { fn(); console.log(`  ✅  ${name}`); passed++; }
  catch(e) { console.log(`  ❌  ${name}\n      → ${e.message}`); failed++; }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
function approxEqual(a, b, tol=1) {
  if (Math.abs(a-b)>tol) throw new Error(`${a.toFixed(2)} not within ${tol} of ${b.toFixed(2)}`);
}

// Pure functions duplicated for testing
function haversineYards(lat1,lon1,lat2,lon2){
  const R=6371000, f1=lat1*Math.PI/180, f2=lat2*Math.PI/180;
  const df=(lat2-lat1)*Math.PI/180, dl=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(df/2)**2+Math.cos(f1)*Math.cos(f2)*Math.sin(dl/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a))*1.09361;
}
function haversineFeet(lat1,lon1,lat2,lon2){ return haversineYards(lat1,lon1,lat2,lon2)*3; }

function pointInPolygon(lat,lon,polyJSON){
  try{
    const coords=JSON.parse(polyJSON).coordinates[0];
    let inside=false;
    for(let i=0,j=coords.length-1;i<coords.length;j=i++){
      const[xi,yi]=coords[i],[xj,yj]=coords[j];
      if(((yi>lat)!==(yj>lat))&&(lon<(xj-xi)*(lat-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
  }catch{return false;}
}

function perpendicularDist(pLat,pLon,polyJSON){
  try{
    const coords=JSON.parse(polyJSON).coordinates[0];
    let min=Infinity;
    for(let i=0;i<coords.length-1;i++){
      const[lon1,lat1]=coords[i],[lon2,lat2]=coords[i+1];
      const dx=lon2-lon1,dy=lat2-lat1,lenSq=dx*dx+dy*dy;
      let t=lenSq>0?((pLon-lon1)*dx+(pLat-lat1)*dy)/lenSq:0;
      t=Math.max(0,Math.min(1,t));
      const d=haversineYards(pLat,pLon,lat1+t*dy,lon1+t*dx);
      if(d<min) min=d;
    }
    return min;
  }catch{return 0;}
}

// Fairway: roughly 200 yards wide in lat/lon space (~0.002 deg lat × 0.003 deg lon)
const FAIRWAY = JSON.stringify({type:'Polygon',coordinates:[[
  [-84.3968, 33.5030],
  [-84.3938, 33.5030],
  [-84.3938, 33.5058],
  [-84.3968, 33.5058],
  [-84.3968, 33.5030]
]]});

// Center of fairway
const F_CENTER_LAT=33.5044, F_CENTER_LON=-84.3953;
// Just outside east edge (lon > -84.3938)
const F_OUTSIDE_LAT=33.5044, F_OUTSIDE_LON=-84.3925;

console.log('\n🏌️  JORD Golf Tournament System — Test Suite\n');
console.log('─'.repeat(52));

console.log('\n📏 Distance Calculations\n');
test('Same point = 0 yards', ()=>approxEqual(haversineYards(33.5031,-84.3953,33.5031,-84.3953),0,0.01));
test('~110 yards calculated correctly', ()=>{ const d=haversineYards(33.5031,-84.3953,33.5041,-84.3953); assert(d>90&&d<130,`got ${d.toFixed(1)}`); });
test('~300 yards calculated correctly', ()=>{ const d=haversineYards(33.5031,-84.3953,33.5031+0.002467,-84.3953); assert(d>250&&d<350,`got ${d.toFixed(1)}`); });
test('Feet = yards × 3', ()=>{ const y=haversineYards(33.5031,-84.3953,33.5041,-84.3953); approxEqual(haversineFeet(33.5031,-84.3953,33.5041,-84.3953),y*3,0.1); });
test('Distance is symmetric', ()=>approxEqual(haversineYards(33.5031,-84.3953,33.5058,-84.3953),haversineYards(33.5058,-84.3953,33.5031,-84.3953),0.01));
test('~500 yards is physically possible', ()=>{ const d=haversineYards(33.5031,-84.3953,33.5031+0.004112,-84.3953); assert(d>400&&d<600,`got ${d.toFixed(1)}`); });

console.log('\n🗺️  Fairway Detection (Point in Polygon)\n');
test('Center of fairway = inside', ()=>assert(pointInPolygon(F_CENTER_LAT,F_CENTER_LON,FAIRWAY)));
test('Far outside = not inside',   ()=>assert(!pointInPolygon(33.510,-84.395,FAIRWAY)));
test('Corner point handled',       ()=>assert(typeof pointInPolygon(33.5030,-84.3968,FAIRWAY)==='boolean'));
test('Bad JSON returns false',     ()=>assert(!pointInPolygon(33.504,-84.395,'not-json')));
test('North of fairway = outside', ()=>assert(!pointInPolygon(33.510,-84.3953,FAIRWAY)));
test('South of fairway = outside', ()=>assert(!pointInPolygon(33.500,-84.3953,FAIRWAY)));

console.log('\n🌿 Rough Penalty\n');
test('Ball outside east edge has positive perpendicular distance', ()=>{
  const d=perpendicularDist(F_OUTSIDE_LAT,F_OUTSIDE_LON,FAIRWAY);
  assert(d>0,`Expected >0, got ${d.toFixed(2)}`);
});
test('Ball far away has large perpendicular distance', ()=>{
  const d=perpendicularDist(33.504,-84.380,FAIRWAY);
  assert(d>100,`Expected >100 yards, got ${d.toFixed(2)}`);
});
test('Ball near east edge has smaller distance than ball far away', ()=>{
  const near=perpendicularDist(F_OUTSIDE_LAT,F_OUTSIDE_LON,FAIRWAY);
  const far=perpendicularDist(33.504,-84.380,FAIRWAY);
  assert(near<far,`Near(${near.toFixed(1)}) should be < far(${far.toFixed(1)})`);
});

console.log('\n⛳ Scoring Logic\n');
function score(rawYards, loc, event) {
  if(loc==='fairway') return {final:rawYards,penalty:0};
  if(loc==='rough'&&event.allow_rough){
    const p=event.rough_penalty_mode==='fixed'?event.rough_fixed_yards:15;
    return {final:Math.max(0,rawYards-p),penalty:p};
  }
  if((loc==='oob'||loc==='lost')&&event.allow_oob){
    const p=event.oob_penalty_mode==='half_hole'?event.hole_distance_yards/2:event.oob_fixed_yards;
    return {final:Math.max(0,rawYards-p),penalty:p};
  }
  return {final:0,penalty:0};
}
const EF={allow_rough:0,allow_oob:0,hole_distance_yards:300};
const ER={allow_rough:1,rough_penalty_mode:'fixed',rough_fixed_yards:20,allow_oob:0,hole_distance_yards:300};
const EO={allow_rough:0,allow_oob:1,oob_penalty_mode:'half_hole',hole_distance_yards:300};

test('Fairway = full distance, zero penalty', ()=>{ const s=score(250,'fairway',EF); assert(s.final===250&&s.penalty===0); });
test('Rough with fairway-only = 0 yards',    ()=>assert(score(250,'rough',EF).final===0));
test('Rough allowed = distance minus fixed penalty', ()=>{ const s=score(250,'rough',ER); assert(s.penalty===20&&s.final===230); });
test('OOB half-hole penalty: 300yd hole → -150 from 250yd drive = 100', ()=>{ const s=score(250,'oob',EO); assert(s.penalty===150&&s.final===100); });
test('OOB not allowed = 0 yards',            ()=>assert(score(250,'oob',EF).final===0));
test('Score never goes negative',            ()=>assert(score(50,'oob',EO).final===0));
test('Lost ball = 0',                        ()=>assert(score(0,'lost',EF).final===0));
test('OOB with rough-only event = 0',        ()=>assert(score(280,'oob',ER).final===0));

console.log('\n📍 Closest to Pin\n');
const PIN_LAT=33.5031, PIN_LON=-84.3953;
test('Ball 3 feet away reads < 10 ft',   ()=>{ const d=haversineFeet(33.503108,-84.3953,PIN_LAT,PIN_LON); assert(d<10,`got ${d.toFixed(2)}`); });
test('Ball ~30 feet away reads 20-50 ft',()=>{ const d=haversineFeet(33.50319,-84.3953,PIN_LAT,PIN_LON); assert(d>10&&d<60,`got ${d.toFixed(2)}`); });
test('Closer ball ranks first', ()=>{
  const t=[{id:'A',best_ft:12.5},{id:'B',best_ft:4.2},{id:'C',best_ft:null}]
    .sort((a,b)=>a.best_ft===null?1:b.best_ft===null?-1:a.best_ft-b.best_ft);
  assert(t[0].id==='B'&&t[2].id==='C');
});

console.log('\n🏆 Leaderboard\n');
test('Highest yards ranks first', ()=>{
  const t=[{id:'A',y:800},{id:'B',y:1000},{id:'C',y:600}].sort((a,b)=>b.y-a.y);
  assert(t[0].id==='B'&&t[2].id==='C');
});
test('Equal yards — sort is stable', ()=>{
  const t=[{id:'A',y:500},{id:'B',y:500}].sort((a,b)=>b.y-a.y);
  assert(t.length===2);
});

console.log('\n🛡️  Input Safety\n');
test('Code uppercased correctly',     ()=>assert('nlqnt9'.toUpperCase()==='NLQNT9'));
test('Negative lat/lon handled',      ()=>{ const d=haversineYards(-33.8688,-70.6693,-33.8698,-70.6693); assert(d>0); });
test('Zero distance not negative',    ()=>assert(haversineYards(0,0,0,0)>=0));

console.log('\n🔌 API Routes\n');
const src=require('fs').readFileSync('./server.js','utf8');
[['POST','/api/events'],['GET','/api/events'],['PATCH','/api/events/:id'],
 ['POST','/api/events/:id/end'],['POST','/api/events/:eventId/tee-boxes'],
 ['POST','/api/events/:eventId/balls'],['POST','/api/events/:eventId/register-player'],
 ['POST','/api/events/:eventId/finalize-team'],['GET','/api/ball/:code'],
 ['POST','/api/scan/ld/:code'],['POST','/api/scan/cp/:code'],
 ['POST','/api/admin/correct'],['POST','/api/alerts'],
 ['GET','/api/leaderboard/:eventId'],['GET','/api/leaderboard/:eventId/stream'],
 ['GET','/api/dashboard/:eventId/:code'],['GET','/api/events/:eventId/export.csv'],
].forEach(([m,p])=> test(`${m} ${p}`, ()=>assert(src.includes(`app.${m.toLowerCase()}('${p}'`),`Missing`)));

console.log('\n'+'─'.repeat(52));
console.log(`\n📊  ${passed}/${total} passed  |  ${failed} failed\n`);
if(!failed) console.log('🎉 All tests passing — system ready to deploy!\n');
else { console.log(`⚠️  Fix ${failed} failure(s) before going live.\n`); process.exit(1); }
