const fs=require('fs');
const {execSync}=require('child_process');
const files=execSync('git ls-files',{cwd:'/tmp/vanpay'}).toString().trim().split('\n')
  .filter(f=>!['.env.example','.gitignore','batch.sftp','package-lock.json'].includes(f));
const dirs=[]; const lines=[];
for(const f of files){
  const dir=f.includes('/')?f.slice(0,f.lastIndexOf('/')):'';
  if(dir && !dirs.includes(dir)){ dirs.push(dir); lines.push('mkdir -p '+dir, 'cd '+dir+'/..'.repeat(0)); }
}
// build: urutkan supaya cd sesuai struktur — pakai pendekatan: upload per-root relatif
console.log(files.join('\n'));
