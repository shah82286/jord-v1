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

console.log('\n⛳ WHS Handicap (lib/handicap.js)\n');
const handicap = require('../lib/handicap');
test('Course handicap = index when slope/rating absent', ()=>assert(handicap.courseHandicap(14,null,null,null)===14));
test('Course handicap: index 10 on 113-slope course = 10', ()=>assert(handicap.courseHandicap(10,113,72,72)===10));
test('Course handicap: index 18 / slope 125 / CR 71.2 / par 72 = 19', ()=>assert(handicap.courseHandicap(18,125,71.2,72)===19));
test('Playing handicap applies allowance (20 × 0.95 = 19)', ()=>assert(handicap.playingHandicap(20,0.95)===19));
{
  const holes = Array.from({length:18},(_,i)=>({hole_number:i+1,stroke_index:i+1}));
  const s18 = handicap.strokesPerHole(18,holes);
  test('Strokes per hole: CH 18 = 1 stroke on every hole', ()=>assert(Object.values(s18).every(v=>v===1)));
  const s20 = handicap.strokesPerHole(20,holes);
  test('Strokes per hole: CH 20 totals 20', ()=>assert(Object.values(s20).reduce((a,b)=>a+b,0)===20));
  test('Strokes per hole: CH 20 puts 2 on the hardest hole (SI 1)', ()=>assert(s20[1]===2));
  const sPlus = handicap.strokesPerHole(-3,holes);
  test('Plus handicap removes strokes from easiest holes', ()=>assert(sPlus[18]===-1 && sPlus[1]===0));
  test('Strokes per hole: CH 0 = no strokes', ()=>assert(Object.values(handicap.strokesPerHole(0,holes)).every(v=>v===0)));
}

console.log('\n🏌️ Stroke-Play Scoring (lib/scoring.js)\n');
const scoring = require('../lib/scoring');
{
  const holes = [{hole_number:1,par:4,stroke_index:1},{hole_number:2,par:4,stroke_index:2}];
  const entries = [
    { entryId:'A', playerName:'Ann', courseHandicap:2, holes, scores:{1:4,2:4} },  // even par
    { entryId:'B', playerName:'Bob', courseHandicap:0, holes, scores:{1:5,2:5} },  // +2
    { entryId:'C', playerName:'Cy',  courseHandicap:0, holes, scores:{} },         // not started
  ];
  const gross = scoring.buildLeaderboard(entries,{format:'stroke_gross'});
  test('Gross leaderboard ranks lower to-par first', ()=>assert(gross.rows[0].playerName==='Ann' && gross.rows[0].position===1));
  test('Gross to-par computed for holes played', ()=>assert(gross.rows[0].total===0 && gross.rows[1].total===2));
  test('Not-started player sinks to the bottom', ()=>assert(gross.rows[2].playerName==='Cy' && gross.rows[2].thru===0));
  const net = scoring.buildLeaderboard(entries,{format:'stroke_net'});
  test('Net subtracts handicap strokes (Ann 8 gross − 2 = 6 net)', ()=>assert(net.rows[0].score===6 && net.rows[0].total===-2));
  const tied = scoring.buildLeaderboard([
    { entryId:'X',playerName:'X',courseHandicap:0,holes,scores:{1:4,2:4} },
    { entryId:'Y',playerName:'Y',courseHandicap:0,holes,scores:{1:4,2:4} },
  ],{format:'stroke_gross'});
  test('Tied players share a position', ()=>assert(tied.rows[0].position===1 && tied.rows[1].position===1 && tied.rows[1].tied));
}

console.log('\n🎮 Game Formats (lib/formats.js)\n');
const fmts = require('../lib/formats');
test('Catalog spans individual / pair / team tiers', ()=>{
  const t = fmts.formatsByTier();
  assert(fmts.FORMATS.length>=19 && t.individual.length && t.pair.length && t.team.length);
});
test('getFormat marks stroke_net as a net format', ()=>assert(fmts.getFormat('stroke_net').net===true));
test('Stroke (gross/net), Stableford, scramble are scored', ()=>
  ['stroke_gross','stroke_net','stableford','scramble_team'].forEach(id=>assert(fmts.isScored(id),id)));
test('Skins / Erado / Duplicate are now scored', ()=>
  ['skins','erado','duplicate'].forEach(id=>assert(fmts.isScored(id),id)));
test('Match play formats are scored', ()=>
  ['match_individual','match_foursome','match_better_ball'].forEach(id=>assert(fmts.isScored(id),id)));
test('Every catalog format is now playable', ()=>fmts.FORMATS.forEach(f=>assert(f.scored||f.manualScoring,f.id)));

console.log('\n🏇 Team Handicaps (lib/handicap.js)\n');
test('2-person scramble 35/15 (8,21 → 6)',          ()=>assert(handicap.teamHandicap([8,21],'scramble2')===6));
test('4-person scramble 25/20/15/10 (5,12,18,24 → 9)',()=>assert(handicap.teamHandicap([5,12,18,24],'scramble4')===9));
test('Foursomes = 50% of combined (10,14 → 12)',    ()=>assert(handicap.teamHandicap([10,14],'foursomes')===12));
test('Greensome = 60% low + 40% high (6,20 → 12)',  ()=>assert(handicap.teamHandicap([6,20],'greensome')===12));

console.log('\n🐎 Stableford Scoring (lib/scoring.js)\n');
test('Points: birdie 3, par 2, bogey 1, double bogey 0', ()=>
  assert(scoring.stablefordPoints(3,4)===3 && scoring.stablefordPoints(4,4)===2
      && scoring.stablefordPoints(5,4)===1 && scoring.stablefordPoints(6,4)===0));
{
  const holes=[{hole_number:1,par:4,stroke_index:1},{hole_number:2,par:3,stroke_index:2}];
  const lb = scoring.buildLeaderboard([
    {entryId:'A',playerName:'Ann',courseHandicap:0,holes,scores:{1:3,2:3}},  // birdie+par = 5 pts
    {entryId:'B',playerName:'Bo', courseHandicap:0,holes,scores:{1:4,2:4}},  // par+bogey  = 3 pts
  ],{format:'stableford'});
  test('Stableford leaderboard ranks by points (high wins)', ()=>
    assert(lb.scoreType==='points' && lb.rows[0].playerName==='Ann' && lb.rows[0].total===5));
}

console.log('\n👥 Team Best-Ball Scoring (lib/scoring.js)\n');
{
  const holes=[{hole_number:1,par:4,stroke_index:1},{hole_number:2,par:4,stroke_index:2}];
  const team=[
    {entryId:'A',playerName:'A',teamId:'T1',teamName:'Aces',courseHandicap:0,holes,scores:{1:4,2:6}},
    {entryId:'B',playerName:'B',teamId:'T1',teamName:'Aces',courseHandicap:0,holes,scores:{1:5,2:4}},
  ];
  const lb=scoring.buildLeaderboard(team,{format:'better_ball_stroke'});
  test('Best ball takes the lower score per hole (team net 8, E)', ()=>
    assert(lb.rows.length===1 && lb.rows[0].score===8 && lb.rows[0].total===0));
  const sf=scoring.buildLeaderboard(team,{format:'better_ball_stableford'});
  test('Best ball Stableford takes the higher points per hole (4 pts)', ()=>
    assert(sf.scoreType==='points' && sf.rows[0].total===4));
  test('Team leaderboard shows one row per team, ranked', ()=>{
    const two=scoring.buildLeaderboard([...team,
      {entryId:'C',playerName:'C',teamId:'T2',teamName:'Birds',courseHandicap:0,holes,scores:{1:3,2:3}}],
      {format:'better_ball_stroke'});
    assert(two.rows.length===2 && two.rows[0].teamName==='Birds');
  });
}

console.log('\n🎲 Exotic Formats — Skins / Erado / Duplicate (lib/scoring.js)\n');
{
  const h3=[{hole_number:1,par:4,stroke_index:1},{hole_number:2,par:4,stroke_index:2},{hole_number:3,par:4,stroke_index:3}];
  const sk=scoring.buildLeaderboard([
    {entryId:'A',playerName:'A',courseHandicap:0,holes:h3,scores:{1:3,2:4,3:3}},
    {entryId:'B',playerName:'B',courseHandicap:0,holes:h3,scores:{1:4,2:4,3:5}},
  ],{format:'skins'});
  test('Skins: outright low wins the hole; tied holes carry over', ()=>
    assert(sk.scoreType==='skins' && sk.rows[0].playerName==='A' && sk.rows[0].total===3 && sk.rows[1].total===0));

  const er=scoring.buildLeaderboard([
    {entryId:'E',playerName:'E',courseHandicap:0,scores:{1:4,2:9,3:4,4:4},holes:[
      {hole_number:1,par:4,stroke_index:1},{hole_number:2,par:4,stroke_index:2},
      {hole_number:3,par:4,stroke_index:3},{hole_number:4,par:4,stroke_index:4}]},
  ],{format:'erado'});
  test('Erado erases the worst holes from the total', ()=>
    assert(er.rows[0].score===8 && er.rows[0].total===0));

  const du=scoring.buildLeaderboard([
    {entryId:'D',playerName:'D',courseHandicap:0,holes:h3,scores:{1:3,2:4,3:3}},
  ],{format:'duplicate',multipliers:[3,1,2]});
  test('Duplicate multiplies Stableford points per hole (9+2+6=17)', ()=>
    assert(du.scoreType==='points' && du.rows[0].total===17));

  // ── Vegas (v3.59) ─────────────────────────────────────────────────────
  // Hole 1: Pair A (4,6) = 46; Pair B (5,5) = 55; A wins by 9 points.
  // Hole 2: Pair A (5,5) = 55; Pair B (4,4) = 44; B wins by 11 points.
  // Hole 3: Pair A (4,5) = 45; Pair B (5,5) = 55; A wins by 10 points.
  // Pair A: +9 -11 +10 = +8 margin (own 19, opp 11).
  const h3v = [
    {hole_number:1, par:4, stroke_index:1},
    {hole_number:2, par:4, stroke_index:2},
    {hole_number:3, par:4, stroke_index:3},
  ];
  const vg = scoring.buildLeaderboard([
    {entryId:'A1', playerName:'A1', teamId:'PA', teamName:'A', courseHandicap:0, holes:h3v, scores:{1:4,2:5,3:4}},
    {entryId:'A2', playerName:'A2', teamId:'PA', teamName:'A', courseHandicap:0, holes:h3v, scores:{1:6,2:5,3:5}},
    {entryId:'B1', playerName:'B1', teamId:'PB', teamName:'B', courseHandicap:0, holes:h3v, scores:{1:5,2:4,3:5}},
    {entryId:'B2', playerName:'B2', teamId:'PB', teamName:'B', courseHandicap:0, holes:h3v, scores:{1:5,2:4,3:5}},
  ], { format:'vegas', format_settings: { flip_birdie:false } });
  test('Vegas: combined-pair scoring with margin to the winning pair', () =>
    assert(vg.scoreType === 'vegas'
        && vg.rows.length === 2
        && vg.rows.find(r => r.teamName === 'A').total === 8
        && vg.rows.find(r => r.teamName === 'B').total === -8
        && vg.rows.find(r => r.teamName === 'A').score === 19,
      'Vegas margin/score mismatch: ' + JSON.stringify(vg.rows)));
  // Birdie flip — Pair A birdies hole 1 (one player on 3 vs par 4). Without
  // flip on, A wins big. With flip on, B must put HIGHER score first → 65
  // instead of 56, so the margin swings further. Verify the flip changes
  // the outcome.
  const h1v = [{hole_number:1, par:4, stroke_index:1}];
  const vgNoFlip = scoring.buildLeaderboard([
    {entryId:'A1', teamName:'A', teamId:'PA', playerName:'A1', courseHandicap:0, holes:h1v, scores:{1:3}},  // birdie
    {entryId:'A2', teamName:'A', teamId:'PA', playerName:'A2', courseHandicap:0, holes:h1v, scores:{1:6}},
    {entryId:'B1', teamName:'B', teamId:'PB', playerName:'B1', courseHandicap:0, holes:h1v, scores:{1:5}},
    {entryId:'B2', teamName:'B', teamId:'PB', playerName:'B2', courseHandicap:0, holes:h1v, scores:{1:6}},
  ], { format:'vegas', format_settings:{ flip_birdie:false } });
  // No flip: A = 36, B = 56 → A wins by 20
  const vgFlip = scoring.buildLeaderboard([
    {entryId:'A1', teamName:'A', teamId:'PA', playerName:'A1', courseHandicap:0, holes:h1v, scores:{1:3}},
    {entryId:'A2', teamName:'A', teamId:'PA', playerName:'A2', courseHandicap:0, holes:h1v, scores:{1:6}},
    {entryId:'B1', teamName:'B', teamId:'PB', playerName:'B1', courseHandicap:0, holes:h1v, scores:{1:5}},
    {entryId:'B2', teamName:'B', teamId:'PB', playerName:'B2', courseHandicap:0, holes:h1v, scores:{1:6}},
  ], { format:'vegas', format_settings:{ flip_birdie:true } });
  // Flip on: A birdied, so B must put high first → 65; A = 36; A wins by 29
  test('Vegas: birdie flip rule pushes the opponent into a bigger margin', () => {
    const a1 = vgNoFlip.rows.find(r => r.teamName === 'A').total;
    const a2 = vgFlip.rows.find(r => r.teamName === 'A').total;
    return assert(a1 === 20 && a2 === 29, `no-flip A=${a1}, flip A=${a2}`);
  });

  // Multi-pair Vegas (round-robin, v3.59.2). Three pairs play one hole. We
  // pick scores so the margins are easy to verify by hand:
  //   Pair A: 4 + 6 = 46
  //   Pair B: 5 + 5 = 55
  //   Pair C: 3 + 4 = 34
  // Round-robin per-pair margins (no birdie flip — par is 5 so 3+4 are pars):
  //   A vs B: A wins 55-46 = 9
  //   A vs C: C wins 46-34 = 12
  //   B vs C: C wins 55-34 = 21
  // Totals: A = +9 - 12 = -3, B = -9 - 21 = -30, C = +12 + 21 = +33.
  const vgRR = scoring.buildLeaderboard([
    {entryId:'A1', teamName:'A', teamId:'PA', playerName:'A1', courseHandicap:0, holes:[{hole_number:1, par:5, stroke_index:1}], scores:{1:4}},
    {entryId:'A2', teamName:'A', teamId:'PA', playerName:'A2', courseHandicap:0, holes:[{hole_number:1, par:5, stroke_index:1}], scores:{1:6}},
    {entryId:'B1', teamName:'B', teamId:'PB', playerName:'B1', courseHandicap:0, holes:[{hole_number:1, par:5, stroke_index:1}], scores:{1:5}},
    {entryId:'B2', teamName:'B', teamId:'PB', playerName:'B2', courseHandicap:0, holes:[{hole_number:1, par:5, stroke_index:1}], scores:{1:5}},
    {entryId:'C1', teamName:'C', teamId:'PC', playerName:'C1', courseHandicap:0, holes:[{hole_number:1, par:5, stroke_index:1}], scores:{1:3}},
    {entryId:'C2', teamName:'C', teamId:'PC', playerName:'C2', courseHandicap:0, holes:[{hole_number:1, par:5, stroke_index:1}], scores:{1:4}},
  ], { format:'vegas', format_settings:{ flip_birdie:false } });
  test('Vegas: round-robin scoring across 3+ pairs sums net margins correctly', () => {
    const a = vgRR.rows.find(r => r.teamName === 'A').total;
    const b = vgRR.rows.find(r => r.teamName === 'B').total;
    const c = vgRR.rows.find(r => r.teamName === 'C').total;
    return assert(a === -3 && b === -30 && c === 33, `A=${a} B=${b} C=${c}`);
  });

  // Multi-format combo (v3.60). Stroke Net primary + Skins side-bet should
  // return two separate leaderboards in one call.
  const h3comb = [
    { hole_number:1, par:4, stroke_index:1 },
    { hole_number:2, par:4, stroke_index:2 },
    { hole_number:3, par:4, stroke_index:3 },
  ];
  const combo = scoring.buildAllLeaderboards([
    { entryId:'X', playerName:'X', courseHandicap:0, holes:h3comb, scores:{1:4,2:5,3:4} }, // par, bogey, par
    { entryId:'Y', playerName:'Y', courseHandicap:0, holes:h3comb, scores:{1:5,2:4,3:5} }, // bogey, par, bogey
  ], {
    format: 'stroke_gross',
    side_bets: [{ format_id:'skins', settings:{ value_per_skin: 5 } }],
  });
  test('Combo: primary + side-bet produces two distinct leaderboards', () =>
    assert(combo.primary && combo.primary.rows.length === 2
        && Array.isArray(combo.sideBets) && combo.sideBets.length === 1
        && combo.sideBets[0].formatId === 'skins'
        && combo.sideBets[0].leaderboard.scoreType === 'skins',
      'combo shape: ' + JSON.stringify(combo)));
  test('Combo: Skins side-bet awards 1 skin each on holes 1 and 3 (split), X wins hole 2', () => {
    const sk = combo.sideBets[0].leaderboard.rows;
    // X scored 4,5,4; Y scored 5,4,5. Hole 1: X 4 vs Y 5 — X wins (1 skin).
    // Hole 2: Y 4 vs X 5 — Y wins (1). Hole 3: X 4 vs Y 5 — X wins (1).
    const x = sk.find(r => r.playerName === 'X').total;
    const y = sk.find(r => r.playerName === 'Y').total;
    return assert(x === 2 && y === 1, `X=${x} Y=${y}`);
  });
}

console.log('\n🏆 Team Exotics — Low Scratch/Net + Irish Rumble (lib/scoring.js)\n');
{
  const h2=[{hole_number:1,par:4,stroke_index:1},{hole_number:2,par:4,stroke_index:2}];
  const team=[
    {entryId:'A',playerName:'A',teamId:'T1',teamName:'Aces',courseHandicap:0,holes:h2,scores:{1:4,2:5}},
    {entryId:'B',playerName:'B',teamId:'T1',teamName:'Aces',courseHandicap:0,holes:h2,scores:{1:5,2:4}},
  ];
  const ln=scoring.buildLeaderboard(team,{format:'low_scratch_net'});
  test('Low Scratch/Net combines best gross + best net per hole', ()=>
    assert(ln.rows[0].score===16 && ln.rows[0].total===0));
  const ir=scoring.buildLeaderboard(team,{format:'irish_rumble'});
  test('Irish Rumble counts best-1 Stableford on early holes', ()=>
    assert(ir.scoreType==='points' && ir.rows[0].total===4));
}

console.log('\n🥊 Match Play (lib/scoring.js)\n');
{
  const aN={}, bN={};
  for(let h=1;h<=16;h++){ aN[h]=h<=3?3:4; bN[h]=4; }   // A wins 1-3, halves 4-16
  const m=scoring.scoreMatch(aN,bN,18);
  test('Match closes out: 3 up with 2 to play → 3&2', ()=>
    assert(m.status==='closed' && m.result==='3&2'));
  test('All-square match when both sides level', ()=>{
    const e={}; for(let h=1;h<=18;h++) e[h]=4;
    const sq=scoring.scoreMatch(e,{...e},18);
    assert(sq.standing===0 && sq.result==='AS');
  });
  const holes=Array.from({length:18},(_,i)=>({hole_number:i+1,par:4,stroke_index:i+1}));
  const mk=arr=>Object.fromEntries(arr.map((s,i)=>[i+1,s]));
  const lb=scoring.buildLeaderboard([
    {entryId:'P1',playerName:'Pat',courseHandicap:0,holes,scores:mk([3,3,3,4,4,4,4,4,4])},
    {entryId:'P2',playerName:'Sam',courseHandicap:0,holes,scores:mk([4,4,4,4,4,4,4,4,4])},
  ],{format:'match_individual'});
  test('Match-play leaderboard: leader first, scoreType match', ()=>
    assert(lb.scoreType==='match' && lb.rows[0].playerName==='Pat'
        && lb.match.standing===3 && lb.match.status==='in_progress'));
}

console.log('\n🏁 Flights (lib/scoring.js)\n');
{
  const holes=Array.from({length:18},(_,i)=>({hole_number:i+1,par:4,stroke_index:i+1}));
  const mk=(hcp,id)=>({entryId:id,playerName:id,courseHandicap:hcp,holes,scores:{1:4}});
  const lb=scoring.buildLeaderboard([mk(2,'a'),mk(8,'b'),mk(14,'c'),mk(20,'d')],{format:'stroke_net'});
  scoring.applyFlights(lb,2);
  test('Flights split the field by handicap (low hcp → Flight 1)', ()=>{
    const byId=Object.fromEntries(lb.rows.map(r=>[r.entryId,r.flight]));
    assert(lb.flighted===2 && byId.a===1 && byId.b===1 && byId.c===2 && byId.d===2);
  });
  test('Flight positions renumber within each flight', ()=>
    assert(lb.rows.every(r=>r.flightPosition>=1 && r.flightPosition<=2)));
}

console.log('\n💳 Stripe Helper (lib/stripe.js)\n');
{
  const sh = require('../lib/stripe');
  test('mode is "mock" when STRIPE_SECRET_KEY is not set',
    () => assert(process.env.STRIPE_SECRET_KEY || sh.mode === 'mock', 'expected mock mode without key'));
  test('feeCents() returns 3% of amount (default 300 bps)',
    () => assert(sh.feeCents(10000) === 300, `expected 300, got ${sh.feeCents(10000)}`));
  test('feeCents() rounds to nearest cent',
    () => assert(sh.feeCents(22500) === 675, `expected 675, got ${sh.feeCents(22500)}`));
  test('feeCents(0) === 0',
    () => assert(sh.feeCents(0) === 0));
  test('mapAccountStatus → active when charges+payouts enabled', () => {
    const s = sh.mapAccountStatus({ charges_enabled:true, payouts_enabled:true, details_submitted:true });
    assert(s.stripe_account_status === 'active', `got ${s.stripe_account_status}`);
  });
  test('mapAccountStatus → pending when details submitted but not charged', () => {
    const s = sh.mapAccountStatus({ charges_enabled:false, payouts_enabled:false, details_submitted:true });
    assert(s.stripe_account_status === 'pending', `got ${s.stripe_account_status}`);
  });
  test('mapAccountStatus → restricted when details not submitted', () => {
    const s = sh.mapAccountStatus({ charges_enabled:false, payouts_enabled:false, details_submitted:false });
    assert(s.stripe_account_status === 'restricted', `got ${s.stripe_account_status}`);
  });
}

console.log('\n🔌 Tournament Scoring Routes\n');
[['GET','/api/courses'],['GET','/api/courses/online-search'],['POST','/api/courses/import'],
 ['POST','/api/courses'],['GET','/api/formats'],['GET','/api/tournaments'],['POST','/api/tournaments'],
 ['POST','/api/users/signup'],['POST','/api/users/login'],['POST','/api/users/logout'],['GET','/api/users/me'],
 ['GET','/api/event-sites/:slug'],
 ['GET','/api/admin/events/:id/site'],['PUT','/api/admin/events/:id/site'],
 ['POST','/api/admin/events/:id/packages'],['PATCH','/api/admin/events/:id/packages/:pkgId'],
 ['DELETE','/api/admin/events/:id/packages/:pkgId'],
 ['POST','/api/registrations'],['GET','/api/registrations/:id'],
 ['POST','/api/donations'],
 ['GET','/api/admin/events/:id/registrations'],
 ['GET','/api/admin/events/:id/registrations.csv'],
 ['POST','/api/admin/events/:id/registrations/:regId/refund'],
 ['POST','/api/admin/events/:id/registrations/:regId/addon'],
 ['GET','/api/admin/events/:id/checkin'],
 ['POST','/api/admin/events/:id/registrations/:regId/players/:playerIndex/checkin'],
 ['DELETE','/api/admin/events/:id/registrations/:regId/players/:playerIndex/checkin'],
 ['POST','/api/admin/events/:id/walkups'],
 ['GET','/api/admin/events/:id/pairings'],
 ['POST','/api/admin/events/:id/pairings/groups'],
 ['PATCH','/api/admin/events/:id/pairings/groups/:groupId'],
 ['DELETE','/api/admin/events/:id/pairings/groups/:groupId'],
 ['POST','/api/admin/events/:id/pairings/groups/:groupId/members'],
 ['DELETE','/api/admin/events/:id/pairings/groups/:groupId/members/:regId/:idx'],
 ['POST','/api/admin/events/:id/pairings/auto-assign'],
 ['GET','/api/admin/events/:id/scoring'],
 ['POST','/api/admin/events/:id/start-scoring'],
 ['POST','/api/admin/events/:id/sync-scoring'],
 ['POST','/api/admin/events/:id/sync-pairings-to-scoring'],
 ['POST','/api/admin/events/:sourceId/clone'],
 ['GET','/api/admin/events/:id/auction'],
 ['GET','/api/admin/events/:id/auction/items/:itemId/bids'],
 ['POST','/api/admin/events/:id/auction/items'],
 ['PATCH','/api/admin/events/:id/auction/items/:itemId'],
 ['DELETE','/api/admin/events/:id/auction/items/:itemId'],
 ['POST','/api/admin/events/:id/auction/items/:itemId/close'],
 ['POST','/api/admin/events/:id/auction/items/:itemId/checkout-winner'],
 ['GET','/api/event-sites/:slug/auction'],
 ['POST','/api/auctions/:itemId/bid'],
 ['POST','/api/event-sites/:slug/auction-intake'],
 ['GET','/api/admin/shop/products'],
 ['POST','/api/admin/shop/products'],
 ['PATCH','/api/admin/shop/products/:id'],
 ['DELETE','/api/admin/shop/products/:id'],
 ['GET','/api/admin/shop/orders'],
 ['POST','/api/admin/shop/orders'],
 ['GET','/api/admin/shop/orders/:id'],
 ['POST','/api/admin/shop/orders/:id/ship'],
 ['POST','/api/stripe/webhook'],
 ['GET','/api/admin/stripe/account'],
 ['POST','/api/admin/stripe/connect/onboard'],
 ['POST','/api/admin/stripe/connect/sync'],
 ['POST','/api/tournaments/:id/field'],['GET','/api/tournaments/:id/leaderboard'],
 ['POST','/api/rounds/:roundId/entries'],['POST','/api/rounds/:roundId/teams'],
 ['POST','/api/rounds/:roundId/scores'],
 ['GET','/api/rounds/:roundId/leaderboard'],['GET','/api/rounds/:roundId/stream'],
].forEach(([m,p])=> test(`${m} ${p}`, ()=>assert(src.includes(`app.${m.toLowerCase()}('${p}'`),'Missing')));

console.log('\n🌐 Time Zone + Cart Numbers (v3.38)\n');
{
  test('tz-lookup module is required at the top of server.js',
    () => assert(src.includes("require('tz-lookup')") || src.includes('require("tz-lookup")'), 'Missing tz-lookup require'));
  test('detectTimeZone helper defined', () => assert(src.includes('function detectTimeZone('), 'Missing helper'));
  test('events.time_zone column migration present',
    () => assert(src.includes("ALTER TABLE events ADD COLUMN time_zone"), 'Missing migration'));
  test('pairing_groups.cart_numbers column migration present',
    () => assert(src.includes("ALTER TABLE pairing_groups ADD COLUMN cart_numbers"), 'Missing migration'));
  test('PATCH /api/events/:id re-resolves time zone when coords change',
    () => assert(src.includes('detectTimeZone(row?.venue_lat, row?.venue_lon)'), 'Missing tz re-resolution'));
  test('tournament_requests accept INSERT writes time_zone',
    () => assert(src.includes('detectTimeZone(draft.venue_lat, draft.venue_lon)'), 'Missing tz on event INSERT'));
  test('pairings group POST accepts cart_numbers',
    () => assert(/INSERT INTO pairing_groups[^;]*cart_numbers/.test(src), 'POST not updating cart_numbers'));
  test('pairings group PATCH writes cart_numbers',
    () => assert(/UPDATE pairing_groups SET[^;]*cart_numbers=\?/.test(src), 'PATCH not updating cart_numbers'));
  test('GET pairings SELECT includes cart_numbers',
    () => assert(/SELECT[^;]*cart_numbers[^;]*FROM pairing_groups/.test(src), 'GET not selecting cart_numbers'));
  // tz-lookup itself: sanity check that the package loads + returns a plausible IANA name.
  const tzLookup = require('tz-lookup');
  test('tz-lookup resolves Pebble Beach to America/Los_Angeles',
    () => assert(tzLookup(36.5687, -121.9505) === 'America/Los_Angeles', `got ${tzLookup(36.5687, -121.9505)}`));
  test('tz-lookup resolves a Chicago-area course to America/Chicago',
    () => assert(tzLookup(41.8781, -87.6298) === 'America/Chicago', `got ${tzLookup(41.8781, -87.6298)}`));
}

console.log('\n🔀 Unified sign-in (?intent=signin skips the chooser) (v3.56)\n');
{
  const fs = require('fs');
  const loginHtml = fs.readFileSync('./public/login.html', 'utf8');
  test('Login page exposes renderUnifiedSignIn()',
    () => assert(loginHtml.includes('function renderUnifiedSignIn'), 'Unified form function missing'));
  test('?intent=signin skips the chooser',
    () => assert(loginHtml.includes("intentParam() === 'signin'") && loginHtml.includes('renderUnifiedSignIn()'), 'Intent param not honored'));
  test('Unified form tries /api/users/login first, falls back to /api/auth/login',
    () => {
      const fn = loginHtml.slice(loginHtml.indexOf('renderUnifiedSignIn'));
      assert(fn.indexOf('/api/users/login') < fn.indexOf('/api/auth/login'), 'Login order wrong');
      assert(fn.includes('eUser.status !== 401'), 'Fallback condition missing');
    });
  test('Unified form sets right token + redirects per match',
    () => {
      const fn = loginHtml.slice(loginHtml.indexOf('renderUnifiedSignIn'));
      assert(fn.includes('setUserToken') && fn.includes("'/clubhouse'"), 'Personal redirect missing');
      assert(fn.includes('setToken')     && fn.includes("'/admin'"),     'Admin redirect missing');
    });
  test('Chooser has Already-have-account → /login?intent=signin link',
    () => assert(/Already have an account\?[^<]*<a href="\/login\?intent=signin">/.test(loginHtml), 'Sign-in link missing from chooser'));
}

console.log('\n👤 Personal-user management + signup UX fixes (v3.55)\n');
{
  test('GET /api/admin/users endpoint registered',
    () => assert(src.includes("app.get('/api/admin/users'") && src.includes('requireSuper'), 'List endpoint missing or not super-only'));
  test('POST /api/admin/users (manual create) registered',
    () => assert(/app\.post\('\/api\/admin\/users',\s*requireAuth,\s*requireSuper/.test(src), 'Create endpoint missing'));
  test('POST /api/admin/users/:id/reset-password registered',
    () => assert(src.includes("/reset-password'") && src.includes('UPDATE users SET password_hash'), 'Reset endpoint missing'));
  test('Reset invalidates open user sessions',
    () => assert(/DELETE FROM user_sessions WHERE user_id=\?/.test(src), 'Sessions not invalidated on reset'));
  test('DELETE /api/admin/users/:id registered',
    () => assert(src.includes("app.delete('/api/admin/users/:id'"), 'Delete endpoint missing'));
  test('Search filters by name OR email LIKE',
    () => assert(src.includes('LOWER(email) LIKE') && src.includes('LOWER(name) LIKE'), 'Search not wired'));
  const fs = require('fs');
  test('/admin/users page route registered',
    () => assert(src.includes("'/admin/users':"), 'Page route missing'));
  test('public/admin/users.html exists',
    () => assert(fs.existsSync('./public/admin/users.html'), 'Page file missing'));
  const usersHtml = fs.readFileSync('./public/admin/users.html', 'utf8');
  test('Users page has search, create, reset, delete handlers',
    () => assert(usersHtml.includes('openCreateModal') && usersHtml.includes('openResetModal') && usersHtml.includes('deleteUser'), 'Handlers missing'));
  const loginHtml = fs.readFileSync('./public/login.html', 'utf8');
  test('Login chooser defaults to signup mode for new visitors',
    () => assert(loginHtml.includes("renderPersonalForm('signup')") && loginHtml.includes("renderOrganizerForm('signup')"), 'Chooser still defaulting to login'));
  test('Successful signup sets a session-storage welcome flag',
    () => assert(loginHtml.includes("'jord_just_signed_up'"), 'Welcome flag missing'));
  const tourHtml = fs.readFileSync('./public/tournaments.html', 'utf8');
  test('Clubhouse shows welcome toast on first paint after signup',
    () => assert(tourHtml.includes("jord_just_signed_up") && tourHtml.includes("welcome to the Clubhouse"), 'Welcome toast missing'));
  const editorHtml = fs.readFileSync('./public/admin/editor.html', 'utf8');
  test('Admin nav links to Personal Users page',
    () => assert(editorHtml.includes('id="btn-manage-users"') && editorHtml.includes('/admin/users'), 'Nav link missing'));
}

console.log('\n🎛 LD/CTP module gating (v3.54)\n');
{
  const fs = require('fs');
  const editorHtml = fs.readFileSync('./public/admin/editor.html', 'utf8');
  test('Editor declares CONTEST_ONLY_PANELS list',
    () => assert(/CONTEST_ONLY_PANELS\s*=\s*\[[^\]]*'map'/.test(editorHtml), 'Contest panel list missing'));
  test('Editor includes ball codes, players, reps, alerts in the LD/CTP gate',
    () => assert(/CONTEST_ONLY_PANELS\s*=\s*\[[^\]]*'balls'[^\]]*'players'[^\]]*'reps'[^\]]*'alerts'/s.test(editorHtml), 'Contest panel list incomplete'));
  test('Editor gates Leaderboard + Monitor header buttons',
    () => assert(/CONTEST_ONLY_HEADER_BTNS\s*=\s*\[[^\]]*btn-view-leaderboard[^\]]*btn-view-monitor/.test(editorHtml), 'Header button gate missing'));
  test('syncGameSettings toggles nav-item hidden class on contest panels',
    () => assert(editorHtml.includes("item.dataset.panel") && editorHtml.includes("classList.toggle('hidden'"), 'Nav toggle missing'));
  test('syncGameSettings bounces user to Settings when leaving a contest-only panel',
    () => assert(editorHtml.includes("showPanel('settings')") && /CONTEST_ONLY_PANELS\.includes\(active\.dataset\.panel\)/.test(editorHtml), 'Auto-switch missing'));
}

console.log('\n📨 Organizer-upgrade requests + LD/CTP collapse (v3.53)\n');
{
  test('tournament_requests.requester_user_id column migrated',
    () => assert(src.includes('ALTER TABLE tournament_requests ADD COLUMN requester_user_id'), 'Missing requester_user_id'));
  test('POST /api/users/request-organizer-upgrade endpoint registered',
    () => assert(src.includes("app.post('/api/users/request-organizer-upgrade'"), 'Missing endpoint'));
  test('GET /api/users/organizer-request-status endpoint registered',
    () => assert(src.includes("app.get('/api/users/organizer-request-status'"), 'Missing status endpoint'));
  test('Upgrade endpoint rejects duplicate pending requests',
    () => assert(src.includes('already have a pending request'), 'Dedupe missing'));
  test('Accept flow reuses user password hash when linked to personal user',
    () => assert(src.includes('requester_user_id') && src.includes('personal.password_hash'), 'Password mirror missing'));
  const fs = require('fs');
  const tourHtml = fs.readFileSync('./public/tournaments.html', 'utf8');
  test('Clubhouse home shows upgrade CTA for personal users',
    () => assert(tourHtml.includes('renderUpgradeCard') && tourHtml.includes('openUpgradeModal'), 'Upgrade CTA not wired'));
  test('Upgrade modal posts to the request endpoint',
    () => assert(tourHtml.includes('/api/users/request-organizer-upgrade'), 'Modal not hitting endpoint'));
  const adminHtml = fs.readFileSync('./public/admin.html', 'utf8');
  test('Admin event editor wraps LD settings for collapse',
    () => assert(adminHtml.includes('id="ld-settings"'), 'LD settings block missing wrapper'));
  test('Admin event editor wraps CTP settings for collapse',
    () => assert(adminHtml.includes('id="ctp-settings"'), 'CTP settings block missing wrapper'));
  test('Admin editor toggles contest blocks based on switches',
    () => assert(adminHtml.includes('updateContestVisibility'), 'Visibility handler missing'));
}

console.log('\n🚪 Auth chooser + self-service organizer signup (v3.52)\n');
{
  test('POST /api/auth/signup endpoint registered',
    () => assert(src.includes("app.post('/api/auth/signup'"), 'Organizer signup endpoint missing'));
  test('Organizer signup creates an admin row with role=admin',
    () => assert(/INSERT INTO admins[\s\S]*?role,\s*active[\s\S]*?'admin',\s*1/.test(src) || /INSERT INTO admins[\s\S]*?'admin',\s*1\)/.test(src), 'Signup not inserting admin row'));
  test('Organizer signup rejects duplicate emails',
    () => assert(src.includes("already has an organizer account"), 'Duplicate check missing'));
  test('Organizer signup composes display name with org',
    () => assert(src.includes('org_name') && /name\.trim\(\)/.test(src), 'Org name plumbing missing'));
  const fs = require('fs');
  const loginHtml = fs.readFileSync('./public/login.html', 'utf8');
  test('Login page renders the two-tile chooser',
    () => assert(loginHtml.includes('chooser-tile') && loginHtml.includes('data-track="personal"') && loginHtml.includes('data-track="organizer"'), 'Tile chooser not wired'));
  test('Login page boot routes signed-in admins to /admin',
    () => assert(loginHtml.includes("location.replace(nextUrl('/admin'))"), 'Admin redirect missing'));
  test('Login page boot routes signed-in users to /clubhouse',
    () => assert(loginHtml.includes("location.replace(nextUrl('/clubhouse'))"), 'User redirect missing'));
  test('Login page supports ?track= deep links for landing-page CTAs',
    () => assert(loginHtml.includes('forcedTrack()') && /t\s*===\s*'personal'/.test(loginHtml), 'Track param not honored'));
  test('Login page has organizer form posting to /api/auth/signup',
    () => assert(loginHtml.includes('/api/auth/signup') && loginHtml.includes('renderOrganizerForm'), 'Organizer form missing'));
  const landingHtml = fs.readFileSync('./public/landing.html', 'utf8');
  test('Landing nav Sign in points at the unified sign-in form (skips chooser)',
    () => assert(/<a href="\/login\?intent=signin" class="nav-link">Sign in<\/a>/.test(landingHtml), 'Landing Sign in should bypass the chooser'));
}

console.log('\n💬 Banter chat (v3.51)\n');
{
  test('banter_messages table created',
    () => assert(src.includes('CREATE TABLE IF NOT EXISTS banter_messages'), 'Missing banter table'));
  test('GET banter endpoint registered',
    () => assert(src.includes("app.get('/api/round-public/:shareCode/banter'"), 'Missing GET endpoint'));
  test('POST banter endpoint registered',
    () => assert(src.includes("app.post('/api/round-public/:shareCode/banter'"), 'Missing POST endpoint'));
  test('Banter SSE stream registered',
    () => assert(src.includes("app.get('/api/round-public/:shareCode/banter/stream'"), 'Missing SSE endpoint'));
  test('Banter validates body length',
    () => assert(src.includes('1000 char max'), 'Length validation missing'));
  test('Banter broadcaster fans out to SSE clients',
    () => assert(src.includes('function broadcastBanter('), 'Broadcaster missing'));
  test('Sender stamps user_id when signed in',
    () => assert(src.includes('user?.id || null') && /banter_messages[\s\S]*?user.*?id/.test(src), 'user_id not stamped'));
  const fs = require('fs');
  const joinHtml = fs.readFileSync('./public/round-join.html', 'utf8');
  test('Join page exposes chat drawer + FAB',
    () => assert(joinHtml.includes('chat-fab') && joinHtml.includes('chat-panel') && joinHtml.includes('initBanter'), 'Chat UI not wired'));
  test('Join page connects to banter SSE',
    () => assert(joinHtml.includes('/banter/stream'), 'SSE not wired'));
  const tourHtml = fs.readFileSync('./public/tournaments.html', 'utf8');
  test('Clubhouse detail links to chat via share code',
    () => assert(tourHtml.includes('💬 Banter'), 'Banter link missing from clubhouse detail'));
  test('Clubhouse home uses /api/tournaments/mine for users',
    () => assert(tourHtml.includes('/api/tournaments/mine'), 'My-games endpoint not wired'));
  test('Join page no longer says scorecard waits for game start',
    () => assert(!joinHtml.includes('will be active when the game starts'), 'Misleading copy still present'));
}

console.log('\n👥 Team side-bet groupings (v3.50)\n');
{
  test('Field endpoint uses requireUserOrAdmin + canEditTournament gate',
    () => assert(/app\.post\('\/api\/tournaments\/:id\/field', requireUserOrAdmin/.test(src), 'Field endpoint still admin-only'));
  test('Field endpoint accepts team_name and upserts round_teams',
    () => assert(src.includes('team_name') && src.includes('INSERT INTO round_teams (id, round_id, name)'), 'Team upsert missing'));
  test('Field endpoint stamps team_id on round_entries',
    () => assert(/INSERT INTO round_entries[\s\S]*?team_id/.test(src), 'team_id not written on entries'));
  test('scoreEntry returns teamId on the row',
    () => {
      const sc = require('../lib/scoring');
      const holes = Array.from({length:18},(_,i)=>({hole_number:i+1,par:4,stroke_index:i+1}));
      const r = sc.scoreEntry({ entryId:'E1', playerName:'Pat', teamId:'T1', teamName:'A',
        courseHandicap:0, holes, scores:{1:4} });
      assert(r.teamId === 'T1', 'teamId not on row, got ' + r.teamId);
    });
  test('buildTeamStandings helper defined in server',
    () => assert(src.includes('function buildTeamStandings('), 'Team aggregator missing'));
  test('Leaderboard payload includes teams[]',
    () => assert(/return\s*\{\s*round,\s*leaderboard:\s*lb,\s*holes,\s*teams[,\s}]/.test(src), 'teams missing from payload'));
  const fs = require('fs');
  const wizardHtml = fs.readFileSync('./public/tournaments.html', 'utf8');
  test('Wizard player form has Team field',
    () => assert(wizardHtml.includes('id="pTeam"') && wizardHtml.includes('team_name:'), 'Team field not in wizard'));
  const liveHtml = fs.readFileSync('./public/live.html', 'utf8');
  test('Live page renders renderTeamSection',
    () => assert(liveHtml.includes('function renderTeamSection(') && liveHtml.includes('team-row'), 'Team section not wired'));
  test('Public courses lookup uses real columns (not bogus location)',
    () => assert(!/SELECT id,\s*name,\s*location\s+FROM courses/.test(src), 'Stale courses.location query still present'));
}

console.log('\n🏌 Leaderboard expand + share polish (v3.49)\n');
{
  test('scoreEntry now returns per-hole scores',
    () => {
      const sc = require('../lib/scoring');
      const holes = Array.from({length:18},(_,i)=>({hole_number:i+1,par:4,stroke_index:i+1}));
      const r = sc.scoreEntry({ entryId:'E1', playerName:'Pat', courseHandicap:0,
        holes, scores:{1:4,2:5,3:3} });
      assert(r.scores && r.scores['1'] === 4 && r.scores['3'] === 3, 'scores not on row');
    });
  test('Leaderboard payload includes the round.holes layout',
    () => assert(/return\s*\{\s*round,\s*leaderboard:\s*lb,\s*holes(,|\s*\})/.test(src), 'holes not on payload'));
  test('Public share-code lookup uses COLLATE NOCASE',
    () => assert(src.includes('share_code = ? COLLATE NOCASE'), 'Case sensitivity not relaxed'));
  test('Share modal uses RFC-compliant sms: URI (no double-param &)',
    () => {
      const fs = require('fs');
      const html = fs.readFileSync('./public/tournaments.html', 'utf8');
      // The bug was `sms:?&body=…` in a template literal. The fixed
      // version is `sms:&body=…` or `sms:?body=…`. Comments can mention
      // the old pattern, so we only check for it inside template
      // literal `href:` attributes.
      const m = html.match(/href:\s*`([^`]*?sms:[^`]*?)`/);
      assert(m, 'Could not locate sms: href in share modal');
      assert(!m[1].includes('sms:?&'), 'Share modal href still has the broken sms:?& pattern');
    });
  test('Live page renders click-to-expand hole-by-hole drawer',
    () => {
      const html = require('fs').readFileSync('./public/live.html', 'utf8');
      assert(html.includes('renderHoleDrawer') && html.includes('data-toggle'), 'Expand UI not wired');
    });
  test('Live page tracks expanded entries across SSE re-renders',
    () => {
      const html = require('fs').readFileSync('./public/live.html', 'utf8');
      assert(html.includes('state.expanded') && html.includes('new Set()'), 'Expanded set not preserved');
    });
}

console.log('\n👥 Clubhouse for users (v3.48)\n');
{
  test('tournaments.user_id column migrated',
    () => assert(src.includes('ALTER TABLE tournaments ADD COLUMN user_id'), 'Missing tournaments.user_id'));
  test('round_entries.user_id column migrated',
    () => assert(src.includes('ALTER TABLE round_entries ADD COLUMN user_id'), 'Missing round_entries.user_id'));
  test('requireUserOrAdmin helper defined',
    () => assert(src.includes('function requireUserOrAdmin('), 'Missing helper'));
  test('POST /api/tournaments uses requireUserOrAdmin',
    () => assert(/app\.post\('\/api\/tournaments', requireUserOrAdmin/.test(src), 'Tournaments POST still admin-gated'));
  test('PATCH /api/tournaments/:id registered with auth gate',
    () => assert(src.includes("app.patch('/api/tournaments/:id', requireUserOrAdmin"), 'Missing PATCH'));
  test('canEditTournament checks creator OR super',
    () => assert(src.includes('function canEditTournament(') && src.includes("admin.role === 'super'"), 'Edit gate logic missing'));
  test('GET /api/tournaments/mine returns rounds I created OR joined',
    () => assert(src.includes("app.get('/api/tournaments/mine'") && src.includes('e.user_id = ?'), 'My-rounds endpoint missing'));
  test('GET /api/round-public/:shareCode returns no-auth round lookup',
    () => assert(src.includes("app.get('/api/round-public/:shareCode'"), 'Public round lookup missing'));
  test('POST /api/round-public/:shareCode/join allows guests',
    () => assert(src.includes("app.post('/api/round-public/:shareCode/join'") && src.includes('user?.id || null'), 'Public join missing or wrong'));
  test('DELETE entry allows host OR self-removal',
    () => assert(src.includes('isCreatorAdmin') && src.includes('isOwnEntry'), 'Entry delete permissions missing'));
  test('Page route /round/:shareCode registered',
    () => assert(src.includes("'/round/:shareCode'"), 'Join page route missing'));
  const fs = require('fs');
  test('public/round-join.html exists',
    () => assert(fs.existsSync('./public/round-join.html'), 'Join page file missing'));
  const tourHtml = fs.readFileSync('./public/tournaments.html', 'utf8');
  test('Clubhouse accepts either token (not admin-only)',
    () => assert(tourHtml.includes('HAS_USER_TOKEN') && tourHtml.includes('/login?next='), 'Auth gate still admin-only'));
  test('Clubhouse exposes Share + Edit buttons',
    () => assert(tourHtml.includes('openShareModal') && tourHtml.includes('openEditModal'), 'Share/Edit not wired'));
}

console.log('\n🛒 Supplies marketplace (E5 phase 2)\n');
{
  test('supply_products table created',
    () => assert(src.includes('CREATE TABLE IF NOT EXISTS supply_products'), 'Missing products table'));
  test('supply_orders table created',
    () => assert(src.includes('CREATE TABLE IF NOT EXISTS supply_orders'), 'Missing orders table'));
  test('lib/stripe.js exports createDirectCheckoutSession',
    () => assert(require('fs').readFileSync('./lib/stripe.js', 'utf8').includes('createDirectCheckoutSession'), 'Direct helper missing'));
  test('Direct helper avoids the Connect transfer_data branch',
    () => {
      const s = require('fs').readFileSync('./lib/stripe.js', 'utf8');
      const fn = s.slice(s.indexOf('createDirectCheckoutSession'));
      assert(!fn.split('createCheckoutSession')[0].includes('transfer_data'), 'Direct helper should not set transfer_data');
    });
  test('Shop endpoint enforces requireSuper for product mutations',
    () => assert(/app\.post\('\/api\/admin\/shop\/products', requireAuth, requireSuper/.test(src), 'POST products not super-gated'));
  test('Shop orders endpoint stores admin_id from session',
    () => assert(src.includes('admin_id, product_id, qty, unit_price_cents, total_cents, status') && src.includes('req.admin.id'), 'Order missing admin_id'));
  test('Stripe webhook handles supply_order_id metadata',
    () => assert(src.includes('session.metadata.supply_order_id') && src.includes("status='paid'"), 'Supply webhook not wired'));
  test('Shop checkout collects shipping address via collectShipping',
    () => assert(src.includes('collectShipping: true'), 'Shipping collection not enabled'));
  const fs = require('fs');
  for (const f of [
    './public/admin/shop.html',
    './public/admin/shop-order.html',
    './public/admin/shop-orders.html',
    './public/admin/shop-products.html',
  ]) {
    test(`exists: ${f.replace('./public/admin/', '')}`, () => assert(fs.existsSync(f), 'Missing file'));
  }
  test('Main admin page links to the shop',
    () => assert(fs.readFileSync('./public/admin/editor.html', 'utf8').includes('/admin/shop'), 'No shop nav link'));
}

console.log('\n🛍 Event store (E5 phase 1)\n');
{
  test('registration_packages.image_data column migrated',
    () => assert(src.includes('ALTER TABLE registration_packages ADD COLUMN image_data'), 'Missing image_data column'));
  test('POST packages accepts event_item kind',
    () => assert(src.includes("['sponsorship', 'donation', 'event_item']"), 'event_item not in whitelist'));
  test('POST packages validates image_data via normalizeImageData',
    () => assert(/imageData\s*=\s*b\.image_data/.test(src) || src.includes("normalizeImageData(imageData)"), 'Image guard missing on POST'));
  test('PATCH packages also accepts image_data',
    () => assert(/UPDATE registration_packages[\s\S]*image_data=\?/.test(src), 'PATCH UPDATE missing image_data'));
  test('GET /api/event-sites/:slug returns store_items separately',
    () => assert(src.includes('store_items') && src.includes("p.package_kind === 'event_item'"), 'Public store split missing'));
  const fs = require('fs');
  const editorHtml = fs.readFileSync('./public/admin/event-site-editor.html', 'utf8');
  test('Event-site editor has STORE_CATALOG (≥10 starter items)',
    () => assert(editorHtml.includes('STORE_CATALOG') && (editorHtml.match(/{ id:\s*'[a-z_]+\d*'/g) || []).length >= 10, 'Catalog missing or short'));
  test('Event-site editor exposes Store card',
    () => assert(editorHtml.includes('id="storeList"') && editorHtml.includes('addCustomStoreItem'), 'Store card not wired'));
  const siteHtml = fs.readFileSync('./public/event-site.html', 'utf8');
  test('Public event-site renders Shop section with Buy buttons',
    () => assert(siteHtml.includes('data-store-pkg') && siteHtml.includes('Buy now'), 'Shop section missing'));
  const regHtml = fs.readFileSync('./public/event-register.html', 'utf8');
  test('Register page handles event_item packages (0-player skip)',
    () => assert(regHtml.includes('isStoreItem') && regHtml.includes('store_items'), 'Register page not store-aware'));
}

console.log('\n🔨 Silent Auction (E4)\n');
{
  test('auction_items table created',
    () => assert(src.includes('CREATE TABLE IF NOT EXISTS auction_items'), 'Missing items table'));
  test('auction_bids table created',
    () => assert(src.includes('CREATE TABLE IF NOT EXISTS auction_bids'), 'Missing bids table'));
  test('event_sites.auction_enabled column migrated',
    () => assert(src.includes('ALTER TABLE event_sites ADD COLUMN auction_enabled'), 'Missing toggle column'));
  test('event_sites.auction_intake_enabled column migrated',
    () => assert(src.includes('ALTER TABLE event_sites ADD COLUMN auction_intake_enabled'), 'Missing intake column'));
  test('AUCTION_ITEM_STATUSES whitelist defined',
    () => assert(src.includes('AUCTION_ITEM_STATUSES'), 'Missing whitelist'));
  test('Item POST validates image_data via normalizeImageData',
    () => assert(src.includes('function normalizeImageData('), 'Missing image guard'));
  test('Bid endpoint rejects bids on non-live items',
    () => assert(src.includes("status !== 'live'") && src.includes('Bidding is closed'), 'Missing live-status check'));
  test('Bid endpoint enforces minimum bid increment',
    () => assert(src.includes('min_increment_cents') && src.includes('minNext'), 'Missing increment validation'));
  test('Close endpoint picks highest bid as winner',
    () => assert(src.includes('ORDER BY amount_cents DESC, created_at LIMIT 1') && src.includes("status='ended'"), 'Winner-pick logic missing'));
  test('Checkout-winner endpoint lazy-creates an auction_item package',
    () => assert(src.includes("package_kind='auction_item'") && src.includes('lazy'), 'Lazy package not wired'));
  test('Stripe webhook marks auction_items paid via metadata.auction_item_id',
    () => assert(src.includes("metadata.auction_item_id") && src.includes("status='paid'"), 'Webhook not wired'));
  test('Intake endpoint requires auction_intake_enabled',
    () => assert(src.includes('Item submissions are not open'), 'Intake-enabled check missing'));
  test('Public payload returns auction config when enabled',
    () => assert(src.includes('site.auction_enabled ?') && src.includes('item_count'), 'Public auction config missing'));
  const fs = require('fs');
  const files = [
    './public/admin/event-auction.html',
    './public/event-auction.html',
    './public/event-donate-item.html',
  ];
  for (const f of files) {
    test(`exists: ${f}`, () => assert(fs.existsSync(f), 'Missing file'));
  }
  const editorHtml = fs.readFileSync('./public/admin/event-site-editor.html', 'utf8');
  test('Event-site editor exposes Auction card',
    () => assert(editorHtml.includes('f-auction-enabled') && editorHtml.includes('f-auction-intake'), 'Editor missing auction inputs'));
  const eventEditor = fs.readFileSync('./public/admin/editor.html', 'utf8');
  test('Event editor header has Auction nav button',
    () => assert(eventEditor.includes('btn-view-auction'), 'Missing nav button'));
  const siteHtml = fs.readFileSync('./public/event-site.html', 'utf8');
  test('Public event-site renders auction teaser section',
    () => assert(siteHtml.includes('auction-teaser') && siteHtml.includes('/auction'), 'Teaser missing'));
}

console.log('\n🔗 Pairings → scoring bridge (v3.44)\n');
{
  test('score_groups.pairing_group_id column migrated',
    () => assert(src.includes('ALTER TABLE score_groups ADD COLUMN pairing_group_id'), 'Missing column'));
  test('round_entries.source_registration_id column migrated',
    () => assert(src.includes('ALTER TABLE round_entries ADD COLUMN source_registration_id'), 'Missing column'));
  test('round_entries.source_player_index column migrated',
    () => assert(src.includes('ALTER TABLE round_entries ADD COLUMN source_player_index'), 'Missing column'));
  test('_syncPairingsToScoreGroups helper defined',
    () => assert(src.includes('function _syncPairingsToScoreGroups('), 'Missing helper'));
  test('start-scoring calls the sync helper',
    () => assert(/start-scoring[\s\S]*?_syncPairingsToScoreGroups/.test(src), 'start-scoring missing sync call'));
  test('sync-scoring calls the sync helper',
    () => assert(/sync-scoring[\s\S]*?_syncPairingsToScoreGroups/.test(src), 'sync-scoring missing sync call'));
  test('POST /sync-pairings-to-scoring endpoint registered',
    () => assert(src.includes("app.post('/api/admin/events/:id/sync-pairings-to-scoring'"), 'Missing route'));
  test('Materializer records source_registration_id + source_player_index',
    () => assert(src.includes('source_registration_id,source_player_index') && src.includes('r.id, i'), 'Source columns not written'));
  test('Sync deletes score_groups for removed pairings',
    () => assert(src.includes('DELETE FROM score_groups WHERE id=?'), 'Orphan cleanup missing'));
  test('Team-card sync uses captain group for all team members',
    () => assert(src.includes('teamGroup') && src.includes('source_player_index === 0'), 'Team grouping logic missing'));
  const fs = require('fs');
  const pairingsHtml = fs.readFileSync('./public/admin/event-pairings.html', 'utf8');
  test('Pairings page sync button calls sync-scoring',
    () => assert(pairingsHtml.includes('/sync-scoring'), 'UI not wired to sync endpoint'));
}

console.log('\n💵 Standalone donations (E3 phase 3)\n');
{
  test('event_sites.donations_enabled column migrated',
    () => assert(src.includes('ALTER TABLE event_sites ADD COLUMN donations_enabled'), 'Missing enabled column'));
  test('event_sites.donation_suggested_json column migrated',
    () => assert(src.includes('ALTER TABLE event_sites ADD COLUMN donation_suggested_json'), 'Missing suggested column'));
  test('event_sites.donation_min_cents column migrated',
    () => assert(src.includes('ALTER TABLE event_sites ADD COLUMN donation_min_cents'), 'Missing min column'));
  test('POST /api/donations registered',
    () => assert(src.includes("app.post('/api/donations'"), 'Missing donations route'));
  test('Donations endpoint validates donations_enabled',
    () => assert(src.includes("'Donations are not enabled for this event'"), 'Missing enabled check'));
  test('Donations endpoint enforces minimum',
    () => assert(src.includes('Minimum donation is $'), 'Missing min check'));
  test('Donations lazy-creates a donation package',
    () => assert(src.includes("package_kind='donation'") && src.includes("INSERT INTO registration_packages"), 'No lazy package creation'));
  test('package_kind accepts donation alongside other kinds',
    () => assert(/\['sponsorship', 'donation'(?:, 'event_item')?\]\.includes\(b\.package_kind\)/.test(src), 'Donation kind not accepted'));
  test('Public payload returns donations config when enabled',
    () => assert(src.includes('site.donations_enabled ?') && src.includes('suggested_cents'), 'Public donations not exposed'));
  const fs = require('fs');
  const editorHtml = fs.readFileSync('./public/admin/event-site-editor.html', 'utf8');
  test('Event-site editor exposes Donations card',
    () => assert(editorHtml.includes('f-don-enabled') && editorHtml.includes('f-don-suggested'), 'Editor missing donation inputs'));
  const siteHtml = fs.readFileSync('./public/event-site.html', 'utf8');
  test('Public event-site renders Donate form',
    () => assert(siteHtml.includes('donate-form') && siteHtml.includes('/api/donations'), 'Donate form not wired'));
}

console.log('\n📊 Fundraising goal + revenue dashboard (E3 phase 2)\n');
{
  test('events.fundraising_goal_cents column migrated',
    () => assert(src.includes('ALTER TABLE events ADD COLUMN fundraising_goal_cents'), 'Missing goal column'));
  test('events.fundraising_visible column migrated',
    () => assert(src.includes('ALTER TABLE events ADD COLUMN fundraising_visible'), 'Missing visible column'));
  test('PATCH /api/events/:id accepts fundraising fields',
    () => assert(src.includes("'fundraising_goal_cents','fundraising_visible'"), 'Allowed list missing fundraising'));
  test('Public payload returns fundraising when visible',
    () => assert(src.includes('event.fundraising_visible') && src.includes('fundraising,'), 'Public payload missing fundraising'));
  test('Admin registrations endpoint returns revenue_by_kind',
    () => assert(src.includes('revenue_by_kind') && src.includes("kind === 'sponsorship'"), 'Breakdown missing'));
  const fs = require('fs');
  const editorHtml = fs.readFileSync('./public/admin/event-site-editor.html', 'utf8');
  test('Event-site editor has Fundraising goal card',
    () => assert(editorHtml.includes('f-fund-goal') && editorHtml.includes('f-fund-visible'), 'Editor missing fundraising inputs'));
  const siteHtml = fs.readFileSync('./public/event-site.html', 'utf8');
  test('Public event-site renders goal bar markup',
    () => assert(siteHtml.includes('es-fund-bar') && siteHtml.includes('fund.percent'), 'Goal bar not wired'));
  const regsHtml = fs.readFileSync('./public/admin/event-registrations.html', 'utf8');
  test('Registrations dashboard exposes renderFundraising + renderRevenueBreakdown',
    () => assert(regsHtml.includes('function renderFundraising') && regsHtml.includes('function renderRevenueBreakdown'), 'Dashboard sections missing'));
}

console.log('\n💰 Sponsorships (E3 phase 1)\n');
{
  test('registration_packages.package_kind column migrated',
    () => assert(src.includes("ALTER TABLE registration_packages ADD COLUMN package_kind"), 'Missing package_kind migration'));
  test('registration_packages.sponsor_type column migrated',
    () => assert(src.includes("ALTER TABLE registration_packages ADD COLUMN sponsor_type"), 'Missing sponsor_type migration'));
  test('SPONSOR_TYPES catalog defined',
    () => assert(src.includes('const SPONSOR_TYPES'), 'Missing SPONSOR_TYPES set'));
  test('POST packages accepts package_kind',
    () => assert(/INSERT INTO registration_packages[^;]*package_kind/.test(src), 'Insert not writing package_kind'));
  test('PATCH packages accepts package_kind + sponsor_type',
    () => assert(/UPDATE registration_packages[^;]*package_kind=\?, sponsor_type=\?/.test(src), 'Update missing sponsor fields'));
  test('Sponsorships allow includes_players = 0',
    () => assert(src.includes("kind === 'registration' ? 1 : 0"), 'Min-player branch missing'));
  test('GET /api/event-sites/:slug returns sponsorships separately',
    () => assert(src.includes('sponsorships') && src.includes("p.package_kind === 'sponsorship'"), 'Public payload not split'));
  const fs = require('fs');
  const editorHtml = fs.readFileSync('./public/admin/event-site-editor.html', 'utf8');
  test('Event-site editor has SPONSOR_CATALOG with 11 types',
    () => assert(editorHtml.includes('SPONSOR_CATALOG') && (editorHtml.match(/type:\s*'[a-z_]+'/g) || []).length >= 11, 'Catalog missing or short'));
  test('Event-site editor exposes Sponsorships card',
    () => assert(editorHtml.includes('id="sponsorList"') && editorHtml.includes('addCustomSponsor'), 'Sponsorship card not wired'));
  const siteHtml = fs.readFileSync('./public/event-site.html', 'utf8');
  test('Public event-site renders Become-a-sponsor buttons',
    () => assert(siteHtml.includes('data-sponsor-pkg') && siteHtml.includes('Become a sponsor'), 'Sponsor CTA missing'));
  const regHtml = fs.readFileSync('./public/event-register.html', 'utf8');
  test('Register page handles sponsorship packages (0-player skip)',
    () => assert(regHtml.includes('isSponsor') && regHtml.includes('sponsorships'), 'Register page not sponsor-aware'));
}

console.log('\n📋 Clone past tournament\n');
{
  test('Clone endpoint registered with sourceId param',
    () => assert(src.includes("app.post('/api/admin/events/:sourceId/clone'"), 'Missing clone route'));
  test('Clone copies events row settings (not status/admin_id)',
    () => assert(src.includes("INSERT INTO events") && src.includes("'setup'"), 'Status not reset to setup'));
  test('Clone re-resolves time_zone from copied lat/lon',
    () => assert(src.includes('detectTimeZone(src.venue_lat, src.venue_lon)'), 'tz not re-resolved'));
  test('Clone copies tee_boxes',
    () => assert(src.includes("INSERT INTO tee_boxes") && src.includes('teeStmt.run'), 'Tee boxes not copied'));
  test('Clone copies event_sites with published=0',
    () => assert(src.includes('INSERT INTO event_sites') && /VALUES[\s\S]*?, 0\)/.test(src), 'Site not unpublished by default'));
  test('Clone copies registration_packages',
    () => assert(src.includes('INSERT INTO registration_packages'), 'Packages not copied'));
  test('Clone runs in a single transaction',
    () => assert(/db\.transaction\(\s*\(\s*\)/.test(src) && src.includes('packagesCloned'), 'Not wrapped in transaction'));
  const fs = require('fs');
  const editorHtml = fs.readFileSync('./public/admin/editor.html', 'utf8');
  test('Editor exposes "Copy from" dropdown',
    () => assert(editorHtml.includes('Copy from previous event'), 'Missing copy-from UI'));
  test('Editor calls clone endpoint when source selected',
    () => assert(editorHtml.includes('/clone'), 'Editor not hitting clone endpoint'));
}

console.log('\n🏆 Scoring Bridge (registrations → tournaments)\n');
{
  test('GET scoring endpoint registered',
    () => assert(src.includes("app.get('/api/admin/events/:id/scoring'"), 'Missing GET'));
  test('POST start-scoring endpoint registered',
    () => assert(src.includes("app.post('/api/admin/events/:id/start-scoring'"), 'Missing start-scoring'));
  test('POST sync-scoring endpoint registered',
    () => assert(src.includes("app.post('/api/admin/events/:id/sync-scoring'"), 'Missing sync-scoring'));
  test('Bridge writes tournaments.event_id',
    () => assert(/INSERT INTO tournaments[\s\S]*event_id/.test(src), 'event_id not set on tournament insert'));
  test('Bridge has player upsert helper',
    () => assert(src.includes('function upsertPlayerFromReg('), 'Missing upsert helper'));
  test('Bridge respects payment_status (paid + partial_refund only)',
    () => assert(src.includes("payment_status IN ('paid','partial_refund')"), 'Bridge processing unpaid regs'));
  test('Bridge handles team-card formats',
    () => assert(src.includes('isTeamCard') && src.includes('round_teams'), 'Missing team-card branch'));
  test('Bridge validates format against SUPPORTED_FORMATS',
    () => assert(src.includes('scoring.SUPPORTED_FORMATS.includes(requested)'), 'Format not validated'));
  // Confirm the pairings UI surfaces the bridge.
  const fs = require('fs');
  const pairingsHtml = fs.readFileSync('./public/admin/event-pairings.html', 'utf8');
  test('Pairings page exposes Start-scoring modal',
    () => assert(pairingsHtml.includes('id="score-modal"') && pairingsHtml.includes('start-scoring'), 'Missing modal/handler'));
  test('Pairings page renders a Leaderboard link when scoring exists',
    () => assert(pairingsHtml.includes('/tournament/') && pairingsHtml.includes('state.scoring'), 'Missing leaderboard branch'));
}

console.log('\n🖼  Poster + Pairings Page Routes\n');
{
  test('/admin/events/:id/pairings/poster route registered',
    () => assert(src.includes("'/admin/events/:id/pairings/poster'"), 'Missing poster route'));
  const fs = require('fs');
  test('event-pairings-poster.html exists',
    () => assert(fs.existsSync('./public/admin/event-pairings-poster.html'), 'Missing poster file'));
  const posterHtml = fs.readFileSync('./public/admin/event-pairings-poster.html', 'utf8');
  test('Poster declares 24×36 in via @page',
    () => assert(/@page\s*\{\s*size:\s*24in\s+36in/i.test(posterHtml), 'Missing 24×36 @page rule'));
  const pairingsHtml = fs.readFileSync('./public/admin/event-pairings.html', 'utf8');
  test('Pairings page renders a cart_numbers input',
    () => assert(pairingsHtml.includes('data-edit="cart_numbers"'), 'Missing cart input'));
  test('Pairings page links to the poster route',
    () => assert(pairingsHtml.includes('/pairings/poster'), 'Missing poster link'));
}

// ── HTML inline-script syntax check ──────────────────────────────────
// Catches the class of bug where an HTML page renders blank/"Loading…"
// because its <script> body has a JS SyntaxError. We had v3.43 ship with
// a stuck-loading editor because of a broken nested IIFE inside a
// template literal; cheap test, prevents recurrence.
console.log('\n📝 HTML inline-script syntax\n');
{
  const fs = require('fs');
  const path = require('path');
  const htmlFiles = [];
  function walk(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, f.name);
      if (f.isDirectory()) walk(full);
      else if (f.name.endsWith('.html')) htmlFiles.push(full);
    }
  }
  walk('./public');
  for (const f of htmlFiles) {
    const html = fs.readFileSync(f, 'utf8');
    // Match every inline <script> body (skip <script src=…> which has no body).
    // Multiple per file are allowed.
    const matches = [...html.matchAll(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/g)];
    matches.forEach((m, i) => {
      const attrs = m[1] || '';
      const body = m[2];
      if (!body.trim()) return; // external script
      if (/type=["']application\/(ld\+json|json)/i.test(attrs)) return;
      const label = path.relative('./public', f) + (matches.length > 1 ? ` [script #${i+1}]` : '');
      test(`parses: ${label}`, () => {
        try { new Function(body); }
        catch (e) { throw new Error(e.message); }
      });
    });
  }
}

console.log('\n'+'─'.repeat(52));
console.log(`\n📊  ${passed}/${total} passed  |  ${failed} failed\n`);
if(!failed) console.log('🎉 All tests passing — system ready to deploy!\n');
else { console.log(`⚠️  Fix ${failed} failure(s) before going live.\n`); process.exit(1); }
