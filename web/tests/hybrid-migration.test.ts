import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createTestDb } from './helpers/surreal-test-db';
import { MIGRATIONS_DIR } from '../scripts/lib/migrate';
it('0011 sobre datos preexistentes: conserva snapshots, materiales y fotos sin inventar nuevas aprobaciones',async()=>{
 const t=await createTestDb(),database=`${t.database}_legacy`;
 try{
   await t.root.query(`DEFINE DATABASE ${database}`).collect();
   await t.root.use({namespace:'dooh_test',database});
   const files=(await readdir(MIGRATIONS_DIR)).filter(f=>f.endsWith('.surql')).sort();
   for(const file of files.filter(f=>f<'0011')){
     const raw=(await readFile(join(MIGRATIONS_DIR,file),'utf8')).replaceAll('{{APP_SERVER_PASSWORD}}',JSON.stringify('test-app-server-pass'));
     await t.root.query(`BEGIN; ${raw} COMMIT;`).retry({enabled:true,attempts:5}).collect();
   }
   await t.root.query(`
     CREATE sys_store:s SET name='Legacy';
     CREATE inv_venue:v SET store=sys_store:s,name='Venue';
     CREATE inv_screen:s SET store=sys_store:s,venue=inv_venue:v,name='Screen';
     CREATE io_order:accepted SET store=sys_store:s,number='ACCEPTED',status='signed',signed_at=time::now(),snapshot_json={original:'preserve'};
     CREATE io_order:quote SET store=sys_store:s,number='QUOTE',created_at=time::now()-1d;
     CREATE io_line:l SET store=sys_store:s,order=io_order:accepted,screen=inv_screen:s,starts_at=d'2026-01-01T05:00:00Z',ends_at=d'2026-01-02T05:00:00Z',cant_slots=1,cant_dias=1;
     CREATE io_creative:c SET store=sys_store:s,order=io_order:accepted,name='Legacy approved',file_url='https://x.pe/a',qc_status='approved',legal_status='approved';
     CREATE io_photo_check:p SET store=sys_store:s,order=io_order:accepted,photo_url='https://x.pe/p';
     CREATE io_agency_order:om SET store=sys_store:s,order=io_order:accepted,kind='OM',code='legacy',document_url='https://x.pe/doc';
   `).collect();
   const raw=await readFile(join(MIGRATIONS_DIR,'0011_hybrid_workflow.surql'),'utf8');
   await t.root.query(`BEGIN; ${raw} COMMIT;`).retry({enabled:true,attempts:5}).collect();
   const [orders,creatives,photos,versions]=await t.root.query('SELECT * FROM io_order; SELECT * FROM io_creative; SELECT * FROM io_photo_check; SELECT * FROM io_order_version').collect() as Array<Array<Record<string,unknown>>>;
   assert.equal(orders.length,2);assert.equal(creatives.length,1);assert.equal(photos.length,1);
   assert.equal(versions.length,1);assert.deepEqual(versions[0].snapshot,{original:'preserve'});
   assert.equal(creatives[0].qc_status,'approved');assert.deepEqual(creatives[0].lines,[]);assert.equal(creatives[0].qc_reviewed_at,undefined);
   assert.equal(photos[0].evidence_kind,'photo');assert.equal(photos[0].line,undefined);
   const quote=orders.find(o=>o.number==='QUOTE')!;assert.equal(quote.reservation_origin,'legacy');assert.equal(Number(quote.workflow_rev),0);
 }finally{
   await t.root.query(`REMOVE DATABASE ${database}`).collect();
   await t.drop();
 }
});
