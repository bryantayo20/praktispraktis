import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const root = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(root, 'data');
const distDir = path.join(root, 'dist');
await mkdir(dataDir, { recursive: true });
const db = new DatabaseSync(process.env.DB_PATH || path.join(dataDir, 'jomitch.sqlite'));
db.exec(`
  PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;
  CREATE TABLE IF NOT EXISTS products (id TEXT PRIMARY KEY, name TEXT NOT NULL, detail TEXT NOT NULL, category TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 0, min INTEGER NOT NULL DEFAULT 8);
  CREATE TABLE IF NOT EXISTS transactions (id TEXT PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, product TEXT NOT NULL, qty INTEGER NOT NULL, total REAL NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, email TEXT NOT NULL, lowStock INTEGER NOT NULL DEFAULT 1, weekly INTEGER NOT NULL DEFAULT 1, emailAlerts INTEGER NOT NULL DEFAULT 1, push INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE COLLATE NOCASE, email TEXT UNIQUE COLLATE NOCASE, phone TEXT UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS account_products (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL, category TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 0, min INTEGER NOT NULL DEFAULT 8, PRIMARY KEY(user_id,id));
  CREATE TABLE IF NOT EXISTS product_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, detail TEXT NOT NULL, category TEXT NOT NULL, cost REAL NOT NULL DEFAULT 0, price REAL NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 0, min INTEGER NOT NULL DEFAULT 8);
  CREATE TABLE IF NOT EXISTS account_transactions (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, product TEXT NOT NULL, qty INTEGER NOT NULL, total REAL NOT NULL DEFAULT 0, PRIMARY KEY(user_id,id));
  CREATE TABLE IF NOT EXISTS account_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', lowStock INTEGER NOT NULL DEFAULT 1, weekly INTEGER NOT NULL DEFAULT 1, emailAlerts INTEGER NOT NULL DEFAULT 1, push INTEGER NOT NULL DEFAULT 1);
`);
const seedItems = [
  ['P-1001','Monello Cat Adult','1 kg · Cat food','Food',118,160,24,8], ['P-1002','Monello Kitten','1 kg · Cat food','Food',130,185,18,8],
  ['P-1003','Powercat Adult','500 g · Cat food','Food',62,100,6,8], ['P-1004','Powercat Kitten','500 g · Cat food','Food',65,110,12,8],
  ['P-1005','Powercat Kitten','1 kg · Cat food','Food',91,145,9,8], ['P-1006','Special Cat Adult','1 kg · Cat food','Food',46,75,3,8],
  ['P-1007','Special Cat Adult','500 g · Cat food','Food',41,70,16,8], ['P-1008','Pawfect Clumping Litter','10 L · Cat care','Care',185,259,21,6],
];
if (db.prepare('SELECT COUNT(*) count FROM products').get().count === 0) {
  const insert = db.prepare('INSERT INTO products VALUES (?,?,?,?,?,?,?,?)');
  for (const row of seedItems) insert.run(...row);
  db.prepare('INSERT OR IGNORE INTO settings (id,name,email) VALUES (1,?,?)').run('Jomitch Dela Cruz','jomitchpetshop@gmail.com');
}
// New accounts receive the existing catalog as a starting template. Transaction history stays empty.
if (db.prepare('SELECT COUNT(*) count FROM product_templates').get().count === 0) {
  const insert = db.prepare('INSERT INTO product_templates VALUES (?,?,?,?,?,?,?,?)');
  const existing=db.prepare('SELECT id,name,detail,category,cost,price,qty,min FROM products ORDER BY rowid').all();
  for (const row of existing.length?existing:seedItems) insert.run(...Object.values(row));
}

const safeUser = user => ({id:user.id,name:user.name,username:user.username,email:user.email||'',phone:user.phone||''});
const cookieName = 'jomitch_session';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const cookieValue = req => (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
function sessionUser(req) {
  const raw = cookieValue(req); if (!raw) return null;
  const token = decodeURIComponent(raw);
  const row = db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?').get(hashToken(token),Date.now());
  return row || null;
}
const corsHeaders = req => {
  const origin = req.headers.origin;
  const allowed = new Set(['http://127.0.0.1:5173','http://localhost:5173']);
  return {'access-control-allow-origin':allowed.has(origin)?origin:'http://127.0.0.1:5173','access-control-allow-credentials':'true','access-control-allow-methods':'GET, POST, PUT, OPTIONS','access-control-allow-headers':'content-type','vary':'Origin'};
};
const sendJson = (req,res,status,value,extra={}) => { res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store',...corsHeaders(req),...extra});res.end(JSON.stringify(value)); };
async function bodyJson(req) { let body=''; for await(const chunk of req){body+=chunk;if(body.length>2_000_000)throw new Error('Request too large');} return JSON.parse(body||'{}'); }
function writeState(userId,state) {
  if (!Array.isArray(state.items)||!Array.isArray(state.tx)||!state.settings) throw new Error('Invalid state payload');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM account_products WHERE user_id=?').run(userId);
    db.prepare('DELETE FROM account_transactions WHERE user_id=?').run(userId);
    const p=db.prepare('INSERT INTO account_products VALUES (?,?,?,?,?,?,?,?,?)');
    for(const x of state.items)p.run(userId,String(x.id),String(x.name),String(x.detail||''),String(x.category||'Food'),Number(x.cost)||0,Number(x.price)||0,Math.max(0,Number(x.qty)||0),Math.max(0,Number(x.min)||0));
    const t=db.prepare('INSERT INTO account_transactions VALUES (?,?,?,?,?,?,?)');
    for(const x of state.tx)t.run(userId,String(x.id),String(x.date),String(x.type),String(x.product),Number(x.qty)||0,Number(x.total)||0);
    const s=state.settings;
    db.prepare(`INSERT INTO account_settings(user_id,name,email,phone,lowStock,weekly,emailAlerts,push) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,lowStock=excluded.lowStock,weekly=excluded.weekly,emailAlerts=excluded.emailAlerts,push=excluded.push`)
      .run(userId,String(s.name||''),String(s.email||''),String(s.phone||''),s.lowStock?1:0,s.weekly?1:0,s.emailAlerts?1:0,s.push?1:0);
    db.exec('COMMIT');
  } catch(e){db.exec('ROLLBACK');throw e;}
}
function readState(user) {
  const id=user.id;
  const items=db.prepare('SELECT id,name,detail,category,cost,price,qty,min FROM account_products WHERE user_id=? ORDER BY rowid DESC').all(id);
  const tx=db.prepare('SELECT id,date,type,product,qty,total FROM account_transactions WHERE user_id=? ORDER BY rowid DESC').all(id);
  const row=db.prepare('SELECT name,email,phone,lowStock,weekly,emailAlerts,push FROM account_settings WHERE user_id=?').get(id);
  return {items,tx,settings:row?{...row,lowStock:!!row.lowStock,weekly:!!row.weekly,emailAlerts:!!row.emailAlerts,push:!!row.push}:{name:user.name,email:user.email||'',phone:user.phone||'',lowStock:true,weekly:true,emailAlerts:true,push:true}};
}
async function makeSession(userId,res,req) {
  const token=randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token),userId,Date.now()+30*24*60*60*1000);
  const secure=process.env.NODE_ENV==='production'?'; Secure':'';
  res.setHeader('set-cookie',`${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure}`);
}

const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpeg':'image/jpeg','.jpg':'image/jpeg','.svg':'image/svg+xml','.woff2':'font/woff2','.woff':'font/woff'};
const server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');
  if(url.pathname.startsWith('/api/')&&req.method==='OPTIONS'){res.writeHead(204,corsHeaders(req));return res.end();}
  if(url.pathname==='/api/health'&&req.method==='GET')return sendJson(req,res,200,{ok:true,database:'sqlite'});
  if(url.pathname==='/api/auth/me'&&req.method==='GET'){const user=sessionUser(req);return user?sendJson(req,res,200,{user:safeUser(user)}):sendJson(req,res,401,{error:'Please sign in.'});}
  if(url.pathname==='/api/auth/signup'&&req.method==='POST'){
    try{
      const b=await bodyJson(req),name=String(b.name||'').trim(),username=String(b.username||'').trim().toLowerCase(),email=String(b.email||'').trim().toLowerCase(),phone=String(b.phone||'').trim(),password=String(b.password||'');
      if(name.length<2||username.length<3||!/^[a-z0-9_]+$/.test(username)||password.length<8||(!email&&!phone))return sendJson(req,res,400,{error:'Enter your name, a username (letters, numbers, underscore; 3+ characters), a password (8+ characters), and an email or phone number.'});
      if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return sendJson(req,res,400,{error:'Enter a valid email address.'});
      if(phone&&phone.replace(/\D/g,'').length<7)return sendJson(req,res,400,{error:'Enter a valid phone number.'});
      const salt=randomBytes(16).toString('hex'),derived=await scrypt(password,salt,64),passwordHash=`${salt}:${derived.toString('hex')}`;
      const id=randomBytes(16).toString('hex');
      db.exec('BEGIN IMMEDIATE');
      try{
        db.prepare('INSERT INTO users(id,name,username,email,phone,password_hash) VALUES(?,?,?,?,?,?)').run(id,name,username,email||null,phone||null,passwordHash);
        db.prepare('INSERT INTO account_products(user_id,id,name,detail,category,cost,price,qty,min) SELECT ?,id,name,detail,category,cost,price,qty,min FROM product_templates').run(id);
        db.prepare('INSERT INTO account_settings(user_id,name,email,phone) VALUES(?,?,?,?)').run(id,name,email,phone);
        db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');if(String(e.message).includes('UNIQUE'))return sendJson(req,res,409,{error:'That username, email, or phone number is already registered.'});throw e;}
      await makeSession(id,res,req);const user=db.prepare('SELECT * FROM users WHERE id=?').get(id);return sendJson(req,res,201,{user:safeUser(user)});
    }catch(e){return sendJson(req,res,400,{error:e.message||'Could not create account.'});}
  }
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){
    try{
      const b=await bodyJson(req),identity=String(b.identity||'').trim(),password=String(b.password||'');
      const user=db.prepare('SELECT * FROM users WHERE username=? COLLATE NOCASE OR email=? COLLATE NOCASE OR phone=?').get(identity,identity.toLowerCase(),identity);
      if(!user)return sendJson(req,res,401,{error:'Username, phone, email, or password is incorrect.'});
      const [salt,stored]=user.password_hash.split(':'),actual=await scrypt(password,salt,64);
      if(!stored||!timingSafeEqual(actual,Buffer.from(stored,'hex')))return sendJson(req,res,401,{error:'Username, phone, email, or password is incorrect.'});
      await makeSession(user.id,res,req);return sendJson(req,res,200,{user:safeUser(user)});
    }catch(e){return sendJson(req,res,400,{error:e.message||'Could not sign in.'});}
  }
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
    const raw=cookieValue(req);if(raw)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hashToken(decodeURIComponent(raw)));
    const secure=process.env.NODE_ENV==='production'?'; Secure':'';
    return sendJson(req,res,200,{ok:true},{'set-cookie':`${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`});
  }
  if(url.pathname==='/api/backup'){
    const user=sessionUser(req);if(!user)return sendJson(req,res,401,{error:'Please sign in.'});
    if(req.method==='GET')return sendJson(req,res,200,{format:'jomitch-account-backup',version:1,exportedAt:new Date().toISOString(),state:readState(user)});
    if(req.method==='PUT'){
      try{const backup=await bodyJson(req);if(backup.format!=='jomitch-account-backup'||backup.version!==1)throw new Error('This backup file is not supported.');writeState(user.id,backup.state);return sendJson(req,res,200,{ok:true});}
      catch(e){return sendJson(req,res,400,{error:e.message});}
    }
  }
  if(url.pathname.startsWith('/api/state')){
    const user=sessionUser(req);if(!user)return sendJson(req,res,401,{error:'Please sign in.'});
    if(url.pathname==='/api/state'&&req.method==='GET')return sendJson(req,res,200,readState(user));
    if(url.pathname==='/api/state'&&req.method==='PUT'){
      try{writeState(user.id,await bodyJson(req));return sendJson(req,res,200,{ok:true});}catch(e){return sendJson(req,res,400,{error:e.message});}
    }
  }
  if(req.method!=='GET'&&req.method!=='HEAD')return sendJson(req,res,405,{error:'Method not allowed'});
  let relative;try{relative=decodeURIComponent(url.pathname);}catch{relative='/';}relative=relative.replace(/^\/+/, '');
  let target=path.resolve(distDir,relative||'index.html');
  if(!target.startsWith(distDir+path.sep)&&target!==path.join(distDir,'index.html'))return sendJson(req,res,403,{error:'Forbidden'});
  try{let content;try{content=await readFile(target);}catch{target=path.join(distDir,'index.html');content=await readFile(target);}res.writeHead(200,{'content-type':mime[path.extname(target)]||'application/octet-stream','cache-control':path.extname(target)==='.html'?'no-cache':'public, max-age=3600'});if(req.method==='HEAD')return res.end();res.end(content);}catch{sendJson(req,res,404,{error:'Build the app first with npm run build'});}
});
const port=Number(process.env.PORT)||Number(process.argv.find(arg=>arg.startsWith('--port='))?.split('=')[1])||4173;
const host=process.env.HOST||'127.0.0.1';server.listen(port,host,()=>console.log(`Jomitch Petshop running at http://${host}:${port} with SQLite account storage`));
