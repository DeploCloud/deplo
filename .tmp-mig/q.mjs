import pg from "pg";
import fs from "node:fs";
const env = Object.fromEntries(fs.readFileSync("/root/projects/deplo/.env","utf8").split("\n").filter(l=>l.includes("=")&&!l.trim().startsWith("#")).map(l=>{const i=l.indexOf("=");return [l.slice(0,i).trim(), l.slice(i+1).trim().replace(/^["']|["']$/g,"")];}));
const c = new pg.Client({connectionString: env.DEPLO_DATABASE_URL});
await c.connect();
const sql = process.argv[2];
const r = await c.query(sql);
console.log(JSON.stringify(r.rows, null, 1));
await c.end();
