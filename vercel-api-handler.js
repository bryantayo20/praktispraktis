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
    CREATE TABLE IF NOT EXISTS account_orders (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL, customer_name TEXT NOT NULL, phone TEXT NOT NULL, fulfillment TEXT NOT NULL, address TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', items JSONB NOT NULL, total DOUBLE PRECISION NOT NULL, status TEXT NOT NULL DEFAULT 'Pending', created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY(user_id,id));
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
    if(pathname==='/api/auth/password'&&req.method==='PUT'){
      const user=await currentUser(req);if(!user)return send(res,401,{error:'Please sign in.'});
      const b=await readBody(req),current=String(b.currentPassword||''),next=String(b.newPassword||'');
      if(next.length<8)return send(res,400,{error:'New password must be at least 8 characters.'});
      const [salt,stored]=user.password_hash.split(':'),actual=await scrypt(current,salt,64);
      if(!stored||!timingSafeEqual(actual,Buffer.from(stored,'hex')))return send(res,401,{error:'Current password is incorrect.'});
      const nextSalt=randomBytes(16).toString('hex'),derived=await scrypt(next,nextSalt,64);
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[`${nextSalt}:${derived.toString('hex')}`,user.id]);
      return send(res,200,{ok:true});
    }
    if(pathname==='/api/auth/profile'&&req.method==='PUT'){
      const user=await currentUser(req);if(!user)return send(res,401,{error:'Please sign in.'});
      const b=await readBody(req),name=String(b.name||'').trim(),email=String(b.email||'').trim().toLowerCase(),phone=String(b.phone||'').trim();
      if(name.length<2)return send(res,400,{error:'Enter your full name.'});
      if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return send(res,400,{error:'Enter a valid email address.'});
      if(phone&&phone.replace(/\D/g,'').length<7)return send(res,400,{error:'Enter a valid phone number.'});
      try{await pool.query('UPDATE users SET name=$1,email=$2,phone=$3 WHERE id=$4',[name,email||null,phone||null,user.id]);await pool.query('UPDATE account_settings SET name=$1,email=$2,phone=$3 WHERE user_id=$4',[name,email,phone,user.id]);}
      catch(e){if(e.code==='23505')return send(res,409,{error:'That email address or phone number is already used by another account.'});throw e;}
      return send(res,200,{ok:true,user:safeUser({...user,name,email,phone})});
    }
    const shopMatch=pathname.match(/^\/api\/shop\/([a-z0-9_]+)(?:\/orders)?$/i);
    if(shopMatch){
      const slug=shopMatch[1].toLowerCase(),orderEndpoint=pathname.endsWith('/orders');
      const ownerResult=await pool.query('SELECT id,name,username FROM users WHERE lower(username)=lower($1) LIMIT 1',[slug]);
      const owner=ownerResult.rows[0];if(!owner)return send(res,404,{error:'Shop not found.'});
      if(!orderEndpoint&&req.method==='GET'){
        const [products,settings]=await Promise.all([
          pool.query('SELECT id,name,detail,category,price,qty FROM account_products WHERE user_id=$1 AND qty>0 ORDER BY name,id',[owner.id]),
          pool.query('SELECT name FROM account_settings WHERE user_id=$1',[owner.id]),
        ]);
        return send(res,200,{shop:{name:owner.username.toLowerCase()==='jomich'?'Jomich Petshop':`${settings.rows[0]?.name||owner.name}'s Petshop`,username:owner.username},products:products.rows});
      }
      if(orderEndpoint&&req.method==='POST'){
        const b=await readBody(req),name=String(b.name||'').trim(),phone=String(b.phone||'').trim(),fulfillment=String(b.fulfillment||''),address=String(b.address||'').trim(),note=String(b.note||'').trim();
        if(name.length<2||phone.replace(/\D/g,'').length<7||!['Pickup','Delivery'].includes(fulfillment)||(fulfillment==='Delivery'&&address.length<8))return send(res,400,{error:'Enter your name, a valid phone number, and delivery address when delivery is selected.'});
        if(!Array.isArray(b.items)||!b.items.length||b.items.length>30)return send(res,400,{error:'Add at least one product to your cart.'});
        const requested=new Map();for(const item of b.items){const id=String(item.id||''),qty=Number(item.qty);if(!id||!Number.isInteger(qty)||qty<1||qty>1000)return send(res,400,{error:'Check product quantities and try again.'});requested.set(id,(requested.get(id)||0)+qty);}
        const ids=[...requested.keys()],result=await pool.query('SELECT id,name,price,qty FROM account_products WHERE user_id=$1 AND id=ANY($2::text[])',[owner.id,ids]);
        if(result.rows.length!==ids.length)return send(res,400,{error:'A product in your cart is no longer available.'});
        const byId=new Map(result.rows.map(p=>[p.id,p]));const lines=[];let total=0;
        for(const [id,qty] of requested){const product=byId.get(id);if(qty>product.qty)return send(res,409,{error:`Only ${product.qty} unit(s) of ${product.name} are currently available.`});const subtotal=Number(product.price)*qty;total+=subtotal;lines.push({id,name:product.name,price:Number(product.price),qty,subtotal});}
        const orderId=`ORD-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`;
        await pool.query('INSERT INTO account_orders(user_id,id,customer_name,phone,fulfillment,address,note,items,total,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)',[owner.id,orderId,name,phone,fulfillment,address,note,JSON.stringify(lines),total,'Pending']);
        return send(res,201,{ok:true,order:{id:orderId,total,status:'Pending'}});
      }
      return send(res,405,{error:'Method not allowed.'});
    }
    if(pathname==='/api/orders'&&req.method==='GET'){
      const user=await currentUser(req);if(!user)return send(res,401,{error:'Please sign in.'});
      const result=await pool.query('SELECT id,customer_name AS "customerName",phone,fulfillment,address,note,items,total,status,created_at AS "createdAt" FROM account_orders WHERE user_id=$1 ORDER BY created_at DESC',[user.id]);
      return send(res,200,{orders:result.rows});
    }
    const orderMatch=pathname.match(/^\/api\/orders\/([A-Za-z0-9_-]+)$/);
    if(orderMatch&&req.method==='PUT'){
      const user=await currentUser(req);if(!user)return send(res,401,{error:'Please sign in.'});
      const {status}=await readBody(req);if(!['Confirmed','Cancelled'].includes(status))return send(res,400,{error:'Choose Confirmed or Cancelled.'});
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        const orderResult=await client.query('SELECT * FROM account_orders WHERE user_id=$1 AND id=$2 FOR UPDATE',[user.id,orderMatch[1]]),order=orderResult.rows[0];
        if(!order){await client.query('ROLLBACK');return send(res,404,{error:'Order not found.'});}
        if(order.status!=='Pending'){await client.query('ROLLBACK');return send(res,409,{error:'This order has already been processed.'});}
        if(status==='Confirmed'){
          for(const line of order.items){
            const updated=await client.query('UPDATE account_products SET qty=qty-$1 WHERE user_id=$2 AND id=$3 AND qty >= $1 RETURNING qty',[line.qty,user.id,line.id]);
            if(!updated.rowCount)throw new Error(`Not enough stock for ${line.name}. Cancel this order or update the inventory first.`);
            await client.query('INSERT INTO account_transactions(user_id,id,date,type,product,qty,total) VALUES($1,$2,$3,$4,$5,$6,$7)',[user.id,`WEB-${order.id}-${line.id}`,new Date().toISOString().slice(0,10),'Sale',line.name,-line.qty,line.subtotal]);
          }
        }
        await client.query('UPDATE account_orders SET status=$1 WHERE user_id=$2 AND id=$3',[status,user.id,order.id]);
        await client.query('COMMIT');
      }catch(error){await client.query('ROLLBACK');return send(res,409,{error:error.message||'Could not process order.'});}finally{client.release();}
      return send(res,200,{ok:true,state:await loadState(user)});
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
