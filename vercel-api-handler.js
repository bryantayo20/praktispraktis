import { Pool } from 'pg';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const pool = globalThis.__jomitchPgPool || new Pool({ connectionString: databaseUrl, max: 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
globalThis.__jomitchPgPool = pool;
const init = globalThis.__jomitchSchemaInit || (globalThis.__jomitchSchemaInit = initialize());
const cookieName = 'jomitch_session';
const hashToken = token => createHash('sha256').update(token).digest('hex');
const safeUser = user => ({id:user.id,name:user.name,username:user.username,email:user.email||'',phone:user.phone||''});

const seedItems = [
  ['P-1001','Monello Cat Adult','1 kg · Cat food','Food',118,160,24,8], ['P-1002','Monello Kitten','1 kg · Cat food','Food',130,185,18,8],
  ['P-1003','Powercat Adult','500 g · Cat food','Food',62,100,6,8], ['P-1004','Powercat Kitten','500 g · Cat food','Food',65,110,12,8],
  ['P-1005','Powercat Kitten','1 kg · Cat food','Food',91,145,9,8], ['P-1006','Special Cat Adult','1 kg · Cat food','Food',46,75,3,8],
  ['P-1007','Special Cat Adult','500 g · Cat food','Food',41,70,16,8], ['P-1008','Pawfect Clumping Litter','10 L · Cat care','Care',185,259,21,6],
];

async function initialize() {
  if (!databaseUrl) throw new Error('DATABASE_URL is not configured. Connect a Postgres database in Vercel.');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, email TEXT UNIQUE, phone TEXT UNIQUE, password_hash TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
    CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL);
    CREATE TABLE IF NOT EXISTS product_templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, detail TEXT NOT NULL, category TEXT NOT NULL, cost DOUBLE PRECISION NOT NULL DEFAULT 0, price DOUBLE PRECISION NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 0, min INTEGER NOT NULL DEFAULT 8);
    CREATE TABLE IF NOT EXISTS account_products (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, name TEXT NOT NULL, detail TEXT NOT NULL, category TEXT NOT NULL, cost DOUBLE PRECISION NOT NULL DEFAULT 0, price DOUBLE PRECISION NOT NULL DEFAULT 0, qty INTEGER NOT NULL DEFAULT 0, min INTEGER NOT NULL DEFAULT 8, PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS account_transactions (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, date TEXT NOT NULL, type TEXT NOT NULL, product TEXT NOT NULL, qty INTEGER NOT NULL, total DOUBLE PRECISION NOT NULL DEFAULT 0, PRIMARY KEY(user_id,id));
    CREATE TABLE IF NOT EXISTS account_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '', low_stock BOOLEAN NOT NULL DEFAULT TRUE, weekly BOOLEAN NOT NULL DEFAULT TRUE, email_alerts BOOLEAN NOT NULL DEFAULT TRUE, push BOOLEAN NOT NULL DEFAULT TRUE);
  `);
  const count = await pool.query('SELECT COUNT(*)::int AS count FROM product_templates');
  if (count.rows[0].count === 0) {
    for (const row of seedItems) await pool.query('INSERT INTO product_templates(id,name,detail,category,cost,price,qty,min) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING', row);
  }
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw=''; for await (const chunk of req) { raw+=chunk; if (raw.length>2_000_000) throw new Error('Request too large'); }
  return JSON.parse(raw||'{}');
}
function send(res,status,payload,headers={}) {
  res.statusCode=status; res.setHeader('content-type','application/json; charset=utf-8'); res.setHeader('cache-control','no-store');
  for (const [key,value] of Object.entries(headers)) res.setHeader(key,value);
  res.end(JSON.stringify(payload));
}
function rawSession(req) {
  const cookies=String(req.headers.cookie||'').split(';').map(v=>v.trim());
  const value=cookies.find(v=>v.startsWith(`${cookieName}=`))?.slice(cookieName.length+1);
  return value?decodeURIComponent(value):null;
}
async function currentUser(req) {
  const token=rawSession(req); if(!token)return null;
  const result=await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',[hashToken(token),Date.now()]);
  return result.rows[0]||null;
}
async function setSession(userId,res) {
  const token=randomBytes(32).toString('base64url');
  await pool.query('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[hashToken(token),userId,Date.now()+30*24*60*60*1000]);
  res.setHeader('set-cookie',`${cookieName}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000; Secure`);
}
async function loadState(user) {
  const [products,tx,settings]=await Promise.all([
    pool.query('SELECT id,name,detail,category,cost,price,qty,min FROM account_products WHERE user_id=$1 ORDER BY id DESC',[user.id]),
    pool.query('SELECT id,date,type,product,qty,total FROM account_transactions WHERE user_id=$1 ORDER BY date DESC,id DESC',[user.id]),
    pool.query('SELECT name,email,phone,low_stock AS "lowStock",weekly,email_alerts AS "emailAlerts",push FROM account_settings WHERE user_id=$1',[user.id]),
  ]);
  const row=settings.rows[0];
  return {items:products.rows,tx:tx.rows,settings:row||{name:user.name,email:user.email||'',phone:user.phone||'',lowStock:true,weekly:true,emailAlerts:true,push:true}};
}
async function saveState(userId,state) {
  if(!Array.isArray(state.items)||!Array.isArray(state.tx)||!state.settings)throw new Error('Invalid state payload');
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('DELETE FROM account_products WHERE user_id=$1',[userId]);
    await client.query('DELETE FROM account_transactions WHERE user_id=$1',[userId]);
    for(const x of state.items)await client.query('INSERT INTO account_products(user_id,id,name,detail,category,cost,price,qty,min) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',[userId,String(x.id),String(x.name),String(x.detail||''),String(x.category||'Food'),Number(x.cost)||0,Number(x.price)||0,Math.max(0,Number(x.qty)||0),Math.max(0,Number(x.min)||0)]);
    for(const x of state.tx)await client.query('INSERT INTO account_transactions(user_id,id,date,type,product,qty,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[userId,String(x.id),String(x.date),String(x.type),String(x.product),Number(x.qty)||0,Number(x.total)||0]);
    const s=state.settings;
    await client.query(`INSERT INTO account_settings(user_id,name,email,phone,low_stock,weekly,email_alerts,push) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(user_id) DO UPDATE SET name=excluded.name,email=excluded.email,phone=excluded.phone,low_stock=excluded.low_stock,weekly=excluded.weekly,email_alerts=excluded.email_alerts,push=excluded.push`,
      [userId,String(s.name||''),String(s.email||''),String(s.phone||''),!!s.lowStock,!!s.weekly,!!s.emailAlerts,!!s.push]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}

export default async function handler(req,res) {
  try {
    await init;
    const pathname=new URL(req.url,'https://vercel.invalid').pathname;
    if(pathname==='/api/health'&&req.method==='GET')return send(res,200,{ok:true,database:'postgres'});
    if(pathname==='/api/auth/me'&&req.method==='GET'){
      const user=await currentUser(req);return user?send(res,200,{user:safeUser(user)}):send(res,401,{error:'Please sign in.'});
    }
    if(pathname==='/api/auth/signup'&&req.method==='POST'){
      const b=await readBody(req),name=String(b.name||'').trim(),username=String(b.username||'').trim().toLowerCase(),email=String(b.email||'').trim().toLowerCase(),phone=String(b.phone||'').trim(),password=String(b.password||'');
      if(name.length<2||username.length<3||!/^[a-z0-9_]+$/.test(username)||password.length<8||(!email&&!phone))return send(res,400,{error:'Enter your name, a username (letters, numbers, underscore; 3+ characters), a password (8+ characters), and an email or phone number.'});
      if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Enter a valid email address.'});
      if(phone&&phone.replace(/\D/g,'').length<7)return send(res,400,{error:'Enter a valid phone number.'});
      const salt=randomBytes(16).toString('hex'),derived=await scrypt(password,salt,64),id=randomBytes(16).toString('hex');
      try{
        await pool.query('INSERT INTO users(id,name,username,email,phone,password_hash) VALUES($1,$2,$3,$4,$5,$6)',[id,name,username,email||null,phone||null,`${salt}:${derived.toString('hex')}`]);
        await pool.query('INSERT INTO account_products(user_id,id,name,detail,category,cost,price,qty,min) SELECT $1,id,name,detail,category,cost,price,qty,min FROM product_templates',[id]);
        await pool.query('INSERT INTO account_settings(user_id,name,email,phone) VALUES($1,$2,$3,$4)',[id,name,email,phone]);
      }catch(e){await pool.query('DELETE FROM users WHERE id=$1',[id]);if(e.code==='23505')return send(res,409,{error:'That username, email, or phone number is already registered.'});throw e;}
      await setSession(id,res);return send(res,201,{user:safeUser({id,name,username,email,phone})});
    }
    if(pathname==='/api/auth/login'&&req.method==='POST'){
      const b=await readBody(req),identity=String(b.identity||'').trim(),password=String(b.password||'');
      const result=await pool.query('SELECT * FROM users WHERE lower(username)=lower($1) OR lower(email)=lower($1) OR phone=$1 LIMIT 1',[identity]);const user=result.rows[0];
      if(!user)return send(res,401,{error:'Username, phone, email, or password is incorrect.'});
      const [salt,stored]=user.password_hash.split(':'),actual=await scrypt(password,salt,64);
      if(!stored||!timingSafeEqual(actual,Buffer.from(stored,'hex')))return send(res,401,{error:'Username, phone, email, or password is incorrect.'});
      await setSession(user.id,res);return send(res,200,{user:safeUser(user)});
    }
    if(pathname==='/api/auth/logout'&&req.method==='POST'){
      const token=rawSession(req);if(token)await pool.query('DELETE FROM sessions WHERE token_hash=$1',[hashToken(token)]);
      return send(res,200,{ok:true},{'set-cookie':`${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0; Secure`});
    }
    if(pathname==='/api/backup'){
      const user=await currentUser(req);if(!user)return send(res,401,{error:'Please sign in.'});
      if(req.method==='GET')return send(res,200,{format:'jomitch-account-backup',version:1,exportedAt:new Date().toISOString(),state:await loadState(user)});
      if(req.method==='PUT'){
        const backup=await readBody(req);if(backup.format!=='jomitch-account-backup'||backup.version!==1)throw new Error('This backup file is not supported.');
        await saveState(user.id,backup.state);return send(res,200,{ok:true});
      }
    }
    if(pathname==='/api/state'){
      const user=await currentUser(req);if(!user)return send(res,401,{error:'Please sign in.'});
      if(req.method==='GET')return send(res,200,await loadState(user));
      if(req.method==='PUT'){await saveState(user.id,await readBody(req));return send(res,200,{ok:true});}
    }
    return send(res,404,{error:'Not found.'});
  }catch(error){
    console.error('API request failed:',error);
    return send(res,500,{error:error.message==='DATABASE_URL is not configured'?'Database is not connected yet.': 'The server could not complete this request.'});
  }
}
