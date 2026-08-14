const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");

const app = express();
const path = require("path");
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE-ME-IN-PRODUCTION";
const db = new sqlite3.Database(process.env.DB_FILE || "./logicontrol.db");

app.use(cors());
app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "..")));

const run = (sql,p=[]) => new Promise((res,rej)=>db.run(sql,p,function(e){e?rej(e):res({id:this.lastID,changes:this.changes})}));
const get = (sql,p=[]) => new Promise((res,rej)=>db.get(sql,p,(e,r)=>e?rej(e):res(r)));
const all = (sql,p=[]) => new Promise((res,rej)=>db.all(sql,p,(e,r)=>e?rej(e):res(r)));
async function tx(fn){ await run("BEGIN IMMEDIATE"); try{const r=await fn();await run("COMMIT");return r}catch(e){try{await run("ROLLBACK")}catch{};throw e}}

db.serialize(async()=>{
  await run("PRAGMA foreign_keys=ON");
  await run(`CREATE TABLE IF NOT EXISTS usuarios(
    id INTEGER PRIMARY KEY AUTOINCREMENT,nome TEXT NOT NULL,email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL,tipo TEXT NOT NULL DEFAULT 'operador',ativo INTEGER NOT NULL DEFAULT 1,
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS clientes(
    id INTEGER PRIMARY KEY AUTOINCREMENT,nome TEXT NOT NULL,cidade TEXT NOT NULL,endereco TEXT NOT NULL,
    telefone TEXT,email TEXT,documento TEXT,ativo INTEGER NOT NULL DEFAULT 1,criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS produtos(
    id INTEGER PRIMARY KEY AUTOINCREMENT,nome TEXT NOT NULL,categoria TEXT NOT NULL DEFAULT 'Sem categoria',
    sku TEXT UNIQUE,quantidade INTEGER NOT NULL DEFAULT 0 CHECK(quantidade>=0),
    estoque_minimo INTEGER NOT NULL DEFAULT 0 CHECK(estoque_minimo>=0),preco_padrao REAL NOT NULL DEFAULT 0 CHECK(preco_padrao>=0),
    ativo INTEGER NOT NULL DEFAULT 1,criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
  await run(`CREATE TABLE IF NOT EXISTS pedidos(
    id INTEGER PRIMARY KEY AUTOINCREMENT,cliente_id INTEGER NOT NULL,usuario_id INTEGER,
    status TEXT NOT NULL DEFAULT 'Pendente',prioridade TEXT NOT NULL DEFAULT 'Normal',
    observacoes TEXT,valor_total REAL NOT NULL DEFAULT 0 CHECK(valor_total>=0),
    criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(cliente_id) REFERENCES clientes(id),FOREIGN KEY(usuario_id) REFERENCES usuarios(id))`);
  await run(`CREATE TABLE IF NOT EXISTS itens_pedido(
    id INTEGER PRIMARY KEY AUTOINCREMENT,pedido_id INTEGER NOT NULL,produto_id INTEGER NOT NULL,
    quantidade INTEGER NOT NULL CHECK(quantidade>0),preco_unitario REAL NOT NULL CHECK(preco_unitario>=0),
    subtotal REAL NOT NULL CHECK(subtotal>=0),FOREIGN KEY(pedido_id) REFERENCES pedidos(id) ON DELETE CASCADE,
    FOREIGN KEY(produto_id) REFERENCES produtos(id))`);
  await run(`CREATE TABLE IF NOT EXISTS movimentacoes_estoque(
    id INTEGER PRIMARY KEY AUTOINCREMENT,produto_id INTEGER NOT NULL,tipo TEXT NOT NULL,
    quantidade INTEGER NOT NULL CHECK(quantidade>0),saldo_anterior INTEGER NOT NULL,saldo_posterior INTEGER NOT NULL,
    motivo TEXT NOT NULL,pedido_id INTEGER,usuario_id INTEGER,criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(produto_id) REFERENCES produtos(id),FOREIGN KEY(pedido_id) REFERENCES pedidos(id),
    FOREIGN KEY(usuario_id) REFERENCES usuarios(id))`);
  await run(`CREATE TABLE IF NOT EXISTS motoristas(
    id INTEGER PRIMARY KEY AUTOINCREMENT,nome TEXT NOT NULL,telefone TEXT,cnh TEXT,
    status TEXT NOT NULL DEFAULT 'Disponível',ativo INTEGER NOT NULL DEFAULT 1)`);
  await run(`CREATE TABLE IF NOT EXISTS veiculos(
    id INTEGER PRIMARY KEY AUTOINCREMENT,placa TEXT NOT NULL UNIQUE,modelo TEXT NOT NULL,
    capacidade_kg REAL DEFAULT 0,status TEXT NOT NULL DEFAULT 'Disponível',ativo INTEGER NOT NULL DEFAULT 1)`);
  await run(`CREATE TABLE IF NOT EXISTS entregas(
    id INTEGER PRIMARY KEY AUTOINCREMENT,pedido_id INTEGER NOT NULL UNIQUE,motorista_id INTEGER,veiculo_id INTEGER,
    origem TEXT,destino TEXT,data_prevista TEXT,data_saida TEXT,data_conclusao TEXT,
    status TEXT NOT NULL DEFAULT 'Aguardando',observacoes TEXT,
    FOREIGN KEY(pedido_id) REFERENCES pedidos(id),FOREIGN KEY(motorista_id) REFERENCES motoristas(id),
    FOREIGN KEY(veiculo_id) REFERENCES veiculos(id))`);
  await run(`CREATE TABLE IF NOT EXISTS custos(
    id INTEGER PRIMARY KEY AUTOINCREMENT,entrega_id INTEGER,tipo TEXT NOT NULL,descricao TEXT,
    valor REAL NOT NULL CHECK(valor>=0),criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(entrega_id) REFERENCES entregas(id))`);
  await run(`CREATE TABLE IF NOT EXISTS auditoria(
    id INTEGER PRIMARY KEY AUTOINCREMENT,usuario_id INTEGER,acao TEXT NOT NULL,entidade TEXT,
    entidade_id INTEGER,detalhes TEXT,criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(usuario_id) REFERENCES usuarios(id))`);
  await run(`CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_mov_produto ON movimentacoes_estoque(produto_id)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_entregas_status ON entregas(status)`);
  const u=await get("SELECT COUNT(*) n FROM usuarios");
  if(u.n===0) await run("INSERT INTO usuarios(nome,email,senha_hash,tipo) VALUES(?,?,?,?)",
    ["Administrador","admin@logicontrol.local",bcrypt.hashSync("1234",10),"admin"]);
}).catch(e=>console.error("DB init:",e));

function auth(req,res,next){
  const h=req.headers.authorization||"",t=h.startsWith("Bearer ")?h.slice(7):null;
  if(!t)return res.status(401).json({erro:"Não autenticado."});
  try{req.user=jwt.verify(t,JWT_SECRET);next()}catch{return res.status(401).json({erro:"Sessão inválida ou expirada."})}
}
function admin(req,res,next){if(req.user.tipo!=="admin")return res.status(403).json({erro:"Acesso restrito ao administrador."});next()}
function audit(user,acao,entidade,id,detalhes=""){return run("INSERT INTO auditoria(usuario_id,acao,entidade,entidade_id,detalhes) VALUES(?,?,?,?,?)",[user?.id||null,acao,entidade,id,detalhes])}
function bad(res,msg){return res.status(400).json({erro:msg})}
const okStatuses=["Pendente","Em preparação","Em transporte","Entregue","Cancelado"];

app.get("/api",(q,s)=>s.json({sistema:"LogiControl",versao:"V8 Simplificada",status:"online"}));
app.get("/health",async(q,s)=>{try{await get("SELECT 1 ok");s.json({status:"ok",banco:"online",versao:"V8"})}catch(e){s.status(503).json({status:"erro",erro:e.message})}});

app.post("/auth/login",async(req,res)=>{try{
  const {email,senha}=req.body,u=await get("SELECT * FROM usuarios WHERE email=? AND ativo=1",[email]);
  if(!u||!bcrypt.compareSync(senha||"",u.senha_hash))return res.status(401).json({erro:"E-mail ou senha inválidos."});
  const token=jwt.sign({id:u.id,nome:u.nome,email:u.email,tipo:u.tipo},JWT_SECRET,{expiresIn:"8h"});
  await audit(u,"LOGIN","usuarios",u.id);
  res.json({token,usuario:{id:u.id,nome:u.nome,email:u.email,tipo:u.tipo}});
}catch(e){res.status(500).json({erro:e.message})}});

app.get("/dashboard",auth,async(req,res)=>{try{
  const [p,c,pe,pend,bx,en,valor,custos]=await Promise.all([
    get("SELECT COUNT(*) n FROM produtos WHERE ativo=1"),get("SELECT COUNT(*) n FROM clientes WHERE ativo=1"),
    get("SELECT COUNT(*) n FROM pedidos"),get("SELECT COUNT(*) n FROM pedidos WHERE status NOT IN ('Entregue','Cancelado')"),
    get("SELECT COUNT(*) n FROM produtos WHERE ativo=1 AND quantidade<=estoque_minimo"),
    get("SELECT COUNT(*) n FROM entregas WHERE status NOT IN ('Concluída','Cancelada')"),
    get("SELECT COALESCE(SUM(valor_total),0) n FROM pedidos WHERE status<>'Cancelado'"),
    get("SELECT COALESCE(SUM(valor),0) n FROM custos")
  ]);
  res.json({produtos:p.n,clientes:c.n,pedidos:pe.n,pendentes:pend.n,estoque_baixo:bx.n,entregas_ativas:en.n,valor_pedidos:valor.n,custos:custos.n});
}catch(e){res.status(500).json({erro:e.message})}});

app.get("/produtos",auth,async(q,s)=>{try{s.json(await all("SELECT p.*,CASE WHEN quantidade<=estoque_minimo THEN 1 ELSE 0 END estoque_baixo FROM produtos p ORDER BY id DESC"))}catch(e){s.status(500).json({erro:e.message})}});
app.post("/produtos",auth,async(req,res)=>{try{
  const {nome,categoria,sku,quantidade,estoque_minimo,preco_padrao}=req.body;
  if(!nome||Number(quantidade)<0||Number(estoque_minimo)<0||Number(preco_padrao||0)<0)return bad(res,"Dados inválidos.");
  const id=await tx(async()=>{
    const x=await run("INSERT INTO produtos(nome,categoria,sku,quantidade,estoque_minimo,preco_padrao) VALUES(?,?,?,?,?,?)",
      [nome,categoria||"Sem categoria",sku||null,Number(quantidade),Number(estoque_minimo),Number(preco_padrao||0)]);
    if(Number(quantidade)>0)await run("INSERT INTO movimentacoes_estoque(produto_id,tipo,quantidade,saldo_anterior,saldo_posterior,motivo,usuario_id) VALUES(?,?,?,?,?,?,?)",
      [x.id,"ENTRADA",Number(quantidade),0,Number(quantidade),"Cadastro inicial",req.user.id]);
    await audit(req.user,"CRIAR","produtos",x.id,nome);return x.id;
  });res.status(201).json(await get("SELECT * FROM produtos WHERE id=?",[id]));
}catch(e){res.status(400).json({erro:e.message})}});

app.post("/produtos/:id/entrada",auth,async(req,res)=>{try{
  const q=Number(req.body.quantidade);if(!Number.isInteger(q)||q<=0)return bad(res,"Quantidade inválida.");
  await tx(async()=>{const p=await get("SELECT * FROM produtos WHERE id=? AND ativo=1",[req.params.id]);if(!p)throw Error("Produto não encontrado.");
    await run("UPDATE produtos SET quantidade=quantidade+? WHERE id=?",[q,p.id]);
    await run("INSERT INTO movimentacoes_estoque(produto_id,tipo,quantidade,saldo_anterior,saldo_posterior,motivo,usuario_id) VALUES(?,?,?,?,?,?,?)",
      [p.id,"ENTRADA",q,p.quantidade,p.quantidade+q,req.body.motivo||"Entrada manual",req.user.id]);
  });res.json(await get("SELECT * FROM produtos WHERE id=?",[req.params.id]));
}catch(e){res.status(400).json({erro:e.message})}});

app.get("/estoque/movimentacoes",auth,async(q,s)=>{try{s.json(await all(`SELECT m.*,p.nome produto_nome,u.nome usuario_nome FROM movimentacoes_estoque m JOIN produtos p ON p.id=m.produto_id LEFT JOIN usuarios u ON u.id=m.usuario_id ORDER BY m.id DESC`))}catch(e){s.status(500).json({erro:e.message})}});

app.get("/clientes",auth,async(q,s)=>{try{s.json(await all("SELECT * FROM clientes WHERE ativo=1 ORDER BY id DESC"))}catch(e){s.status(500).json({erro:e.message})}});
app.post("/clientes",auth,async(req,res)=>{try{
 const {nome,cidade,endereco,telefone,email,documento}=req.body;if(!nome||!cidade||!endereco)return bad(res,"Nome, cidade e endereço são obrigatórios.");
 const x=await run("INSERT INTO clientes(nome,cidade,endereco,telefone,email,documento) VALUES(?,?,?,?,?,?)",[nome,cidade,endereco,telefone||null,email||null,documento||null]);
 await audit(req.user,"CRIAR","clientes",x.id,nome);res.status(201).json(await get("SELECT * FROM clientes WHERE id=?",[x.id]));
}catch(e){res.status(400).json({erro:e.message})}});

app.get("/pedidos",auth,async(q,s)=>{try{s.json(await all("SELECT p.*,c.nome cliente_nome FROM pedidos p JOIN clientes c ON c.id=p.cliente_id ORDER BY p.id DESC"))}catch(e){s.status(500).json({erro:e.message})}});
app.get("/pedidos/:id",auth,async(req,res)=>{try{
 const p=await get("SELECT p.*,c.nome cliente_nome FROM pedidos p JOIN clientes c ON c.id=p.cliente_id WHERE p.id=?",[req.params.id]);
 if(!p)return res.status(404).json({erro:"Pedido não encontrado."});
 p.itens=await all("SELECT i.*,pr.nome produto_nome,pr.sku FROM itens_pedido i JOIN produtos pr ON pr.id=i.produto_id WHERE i.pedido_id=?",[p.id]);res.json(p)
}catch(e){res.status(500).json({erro:e.message})}});

app.post("/pedidos",auth,async(req,res)=>{try{
 const {cliente_id,status,prioridade,observacoes,itens}=req.body;
 if(!cliente_id||!Array.isArray(itens)||!itens.length)return bad(res,"Cliente e itens são obrigatórios.");
 if(status&&!okStatuses.includes(status))return bad(res,"Status inválido.");
 const id=await tx(async()=>{
   if(!await get("SELECT id FROM clientes WHERE id=? AND ativo=1",[cliente_id]))throw Error("Cliente não existe.");
   let total=0,linhas=[];
   for(const i of itens){
     const q=Number(i.quantidade),p=await get("SELECT * FROM produtos WHERE id=? AND ativo=1",[i.produto_id]);
     if(!p)throw Error("Produto não encontrado.");
     if(!Number.isInteger(q)||q<=0)throw Error("Quantidade inválida.");
     if(p.quantidade<q)throw Error(`Estoque insuficiente para ${p.nome}. Disponível: ${p.quantidade}.`);
     const preco=i.preco_unitario===""||i.preco_unitario==null?p.preco_padrao:Number(i.preco_unitario);
     if(preco<0||!Number.isFinite(preco))throw Error("Preço inválido.");
     const sub=q*preco;total+=sub;linhas.push({p,q,preco,sub});
   }
   const x=await run("INSERT INTO pedidos(cliente_id,usuario_id,status,prioridade,observacoes,valor_total) VALUES(?,?,?,?,?,?)",
     [cliente_id,req.user.id,status||"Pendente",prioridade||"Normal",observacoes||null,total]);
   for(const l of linhas){
     await run("INSERT INTO itens_pedido(pedido_id,produto_id,quantidade,preco_unitario,subtotal) VALUES(?,?,?,?,?)",[x.id,l.p.id,l.q,l.preco,l.sub]);
     await run("UPDATE produtos SET quantidade=quantidade-? WHERE id=?",[l.q,l.p.id]);
     await run("INSERT INTO movimentacoes_estoque(produto_id,tipo,quantidade,saldo_anterior,saldo_posterior,motivo,pedido_id,usuario_id) VALUES(?,?,?,?,?,?,?,?)",
       [l.p.id,"SAIDA",l.q,l.p.quantidade,l.p.quantidade-l.q,"Pedido #"+x.id,x.id,req.user.id]);
   }
   await audit(req.user,"CRIAR","pedidos",x.id,`Total ${total}`);return x.id;
 });
 res.status(201).json(await get("SELECT * FROM pedidos WHERE id=?",[id]));
}catch(e){res.status(400).json({erro:e.message})}});

app.patch("/pedidos/:id/status",auth,async(req,res)=>{try{
 const {status}=req.body;if(!okStatuses.includes(status))return bad(res,"Status inválido.");
 const x=await run("UPDATE pedidos SET status=?,atualizado_em=CURRENT_TIMESTAMP WHERE id=?",[status,req.params.id]);
 if(!x.changes)return res.status(404).json({erro:"Pedido não encontrado."});
 await audit(req.user,"STATUS","pedidos",Number(req.params.id),status);res.json(await get("SELECT * FROM pedidos WHERE id=?",[req.params.id]));
}catch(e){res.status(400).json({erro:e.message})}});

app.get("/motoristas",auth,async(q,s)=>{try{s.json(await all("SELECT * FROM motoristas WHERE ativo=1 ORDER BY id DESC"))}catch(e){s.status(500).json({erro:e.message})}});
app.post("/motoristas",auth,async(req,res)=>{try{const {nome,telefone,cnh,status}=req.body;if(!nome)return bad(res,"Nome obrigatório.");const x=await run("INSERT INTO motoristas(nome,telefone,cnh,status) VALUES(?,?,?,?)",[nome,telefone||null,cnh||null,status||"Disponível"]);res.status(201).json(await get("SELECT * FROM motoristas WHERE id=?",[x.id]))}catch(e){res.status(400).json({erro:e.message})}});
app.get("/veiculos",auth,async(q,s)=>{try{s.json(await all("SELECT * FROM veiculos WHERE ativo=1 ORDER BY id DESC"))}catch(e){s.status(500).json({erro:e.message})}});
app.post("/veiculos",auth,async(req,res)=>{try{const {placa,modelo,capacidade_kg,status}=req.body;if(!placa||!modelo)return bad(res,"Placa e modelo obrigatórios.");const x=await run("INSERT INTO veiculos(placa,modelo,capacidade_kg,status) VALUES(?,?,?,?)",[placa.toUpperCase(),modelo,Number(capacidade_kg||0),status||"Disponível"]);res.status(201).json(await get("SELECT * FROM veiculos WHERE id=?",[x.id]))}catch(e){res.status(400).json({erro:e.message})}});

app.get("/entregas",auth,async(q,s)=>{try{s.json(await all(`SELECT e.*,p.valor_total,c.nome cliente_nome,m.nome motorista_nome,v.placa veiculo_placa
 FROM entregas e JOIN pedidos p ON p.id=e.pedido_id JOIN clientes c ON c.id=p.cliente_id
 LEFT JOIN motoristas m ON m.id=e.motorista_id LEFT JOIN veiculos v ON v.id=e.veiculo_id ORDER BY e.id DESC`))}catch(e){s.status(500).json({erro:e.message})}});
app.post("/entregas",auth,async(req,res)=>{try{
 const {pedido_id,motorista_id,veiculo_id,origem,destino,data_prevista,observacoes}=req.body;
 if(!pedido_id||!destino)return bad(res,"Pedido e destino obrigatórios.");
 if(await get("SELECT id FROM entregas WHERE pedido_id=?",[pedido_id]))return bad(res,"Este pedido já possui uma entrega.");
 const x=await run("INSERT INTO entregas(pedido_id,motorista_id,veiculo_id,origem,destino,data_prevista,observacoes) VALUES(?,?,?,?,?,?,?)",
   [pedido_id,motorista_id||null,veiculo_id||null,origem||null,destino,data_prevista||null,observacoes||null]);
 await audit(req.user,"CRIAR","entregas",x.id);res.status(201).json(await get("SELECT * FROM entregas WHERE id=?",[x.id]));
}catch(e){res.status(400).json({erro:e.message})}});
app.patch("/entregas/:id/status",auth,async(req,res)=>{try{
 const {status}=req.body,valid=["Aguardando","Em preparação","Em transporte","Concluída","Cancelada"];
 if(!valid.includes(status))return bad(res,"Status inválido.");
 const now=status==="Em transporte"?"CURRENT_TIMESTAMP":status==="Concluída"?"CURRENT_TIMESTAMP":"NULL";
 let sql="UPDATE entregas SET status=?";let p=[status];
 if(status==="Em transporte"){sql+=",data_saida=CURRENT_TIMESTAMP"}if(status==="Concluída"){sql+=",data_conclusao=CURRENT_TIMESTAMP"}sql+=" WHERE id=?";p.push(req.params.id);
 const x=await run(sql,p);if(!x.changes)return res.status(404).json({erro:"Entrega não encontrada."});await audit(req.user,"STATUS","entregas",Number(req.params.id),status);res.json(await get("SELECT * FROM entregas WHERE id=?",[req.params.id]))
}catch(e){res.status(400).json({erro:e.message})}});

app.get("/custos",auth,async(q,s)=>{try{s.json(await all("SELECT c.*,e.pedido_id FROM custos c LEFT JOIN entregas e ON e.id=c.entrega_id ORDER BY c.id DESC"))}catch(e){s.status(500).json({erro:e.message})}});
app.post("/custos",auth,async(req,res)=>{try{const {entrega_id,tipo,descricao,valor}=req.body;if(!tipo||Number(valor)<0)return bad(res,"Tipo e valor inválidos.");const x=await run("INSERT INTO custos(entrega_id,tipo,descricao,valor) VALUES(?,?,?,?)",[entrega_id||null,tipo,descricao||null,Number(valor)]);await audit(req.user,"CRIAR","custos",x.id);res.status(201).json(await get("SELECT * FROM custos WHERE id=?",[x.id]))}catch(e){res.status(400).json({erro:e.message})}});

app.get("/relatorios/resumo",auth,async(req,res)=>{try{
 const pedidos=await all(`SELECT status,COUNT(*) quantidade,COALESCE(SUM(valor_total),0) valor FROM pedidos GROUP BY status`);
 const estoque=await all(`SELECT id,nome,quantidade,estoque_minimo FROM produtos WHERE ativo=1 AND quantidade<=estoque_minimo ORDER BY quantidade ASC`);
 const custos=await get("SELECT COALESCE(SUM(valor),0) total FROM custos");
 const ticket=await get("SELECT COALESCE(AVG(valor_total),0) medio FROM pedidos WHERE status<>'Cancelado'");
 res.json({pedidos,estoque_baixo:estoque,custos_total:custos.total,ticket_medio:ticket.medio});
}catch(e){res.status(500).json({erro:e.message})}});

app.get("/auditoria",auth,admin,async(q,s)=>{try{s.json(await all(`SELECT a.*,u.nome usuario_nome FROM auditoria a LEFT JOIN usuarios u ON u.id=a.usuario_id ORDER BY a.id DESC LIMIT 500`))}catch(e){s.status(500).json({erro:e.message})}});
app.get("/usuarios",auth,admin,async(q,s)=>{try{s.json(await all("SELECT id,nome,email,tipo,ativo,criado_em FROM usuarios ORDER BY id DESC"))}catch(e){s.status(500).json({erro:e.message})}});
app.post("/usuarios",auth,admin,async(req,res)=>{try{const {nome,email,senha,tipo}=req.body;if(!nome||!email||!senha)return bad(res,"Nome, e-mail e senha obrigatórios.");const x=await run("INSERT INTO usuarios(nome,email,senha_hash,tipo) VALUES(?,?,?,?)",[nome,email,bcrypt.hashSync(senha,10),tipo||"operador"]);res.status(201).json(await get("SELECT id,nome,email,tipo,ativo FROM usuarios WHERE id=?",[x.id]))}catch(e){res.status(400).json({erro:e.message})}});

app.get("*",(req,res)=>{ if(req.path.startsWith("/api") || req.path.startsWith("/auth") || req.path.startsWith("/dashboard") || req.path.startsWith("/produtos") || req.path.startsWith("/clientes") || req.path.startsWith("/pedidos") || req.path.startsWith("/estoque") || req.path.startsWith("/motoristas") || req.path.startsWith("/veiculos") || req.path.startsWith("/entregas") || req.path.startsWith("/custos") || req.path.startsWith("/relatorios") || req.path.startsWith("/auditoria") || req.path.startsWith("/usuarios") || req.path.startsWith("/health")) return res.status(404).json({erro:"Rota não encontrada."}); res.sendFile(path.join(__dirname,"..","index.html")); });

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      senha TEXT NOT NULL,
      perfil TEXT NOT NULL DEFAULT 'operador',
      ativo BOOLEAN NOT NULL DEFAULT TRUE,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS produtos (
      id SERIAL PRIMARY KEY,
      sku TEXT UNIQUE NOT NULL,
      nome TEXT NOT NULL,
      quantidade NUMERIC NOT NULL DEFAULT 0,
      preco NUMERIC(12,2) NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      documento TEXT,
      telefone TEXT,
      email TEXT,
      endereco TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      cliente_id INTEGER REFERENCES clientes(id),
      status TEXT NOT NULL DEFAULT 'pendente',
      total NUMERIC(12,2) NOT NULL DEFAULT 0,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pedido_itens (
      id SERIAL PRIMARY KEY,
      pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      produto_id INTEGER NOT NULL REFERENCES produtos(id),
      quantidade NUMERIC NOT NULL,
      preco_unitario NUMERIC(12,2) NOT NULL
    );
    CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
      id SERIAL PRIMARY KEY,
      produto_id INTEGER NOT NULL REFERENCES produtos(id),
      tipo TEXT NOT NULL,
      quantidade NUMERIC NOT NULL,
      saldo_anterior NUMERIC NOT NULL,
      saldo_posterior NUMERIC NOT NULL,
      referencia TEXT,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS motoristas (
      id SERIAL PRIMARY KEY,
      nome TEXT NOT NULL,
      telefone TEXT,
      documento TEXT,
      ativo BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS veiculos (
      id SERIAL PRIMARY KEY,
      placa TEXT UNIQUE NOT NULL,
      modelo TEXT,
      capacidade NUMERIC DEFAULT 0,
      ativo BOOLEAN NOT NULL DEFAULT TRUE
    );
    CREATE TABLE IF NOT EXISTS entregas (
      id SERIAL PRIMARY KEY,
      pedido_id INTEGER REFERENCES pedidos(id),
      motorista_id INTEGER REFERENCES motoristas(id),
      veiculo_id INTEGER REFERENCES veiculos(id),
      status TEXT NOT NULL DEFAULT 'pendente',
      data_prevista TIMESTAMPTZ,
      data_entrega TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS custos (
      id SERIAL PRIMARY KEY,
      descricao TEXT NOT NULL,
      categoria TEXT,
      valor NUMERIC(12,2) NOT NULL DEFAULT 0,
      data TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS auditoria (
      id SERIAL PRIMARY KEY,
      usuario_id INTEGER REFERENCES usuarios(id),
      acao TEXT NOT NULL,
      entidade TEXT,
      entidade_id INTEGER,
      detalhes JSONB,
      criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
  const adminEmail = process.env.ADMIN_EMAIL;
  const adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('Configure ADMIN_EMAIL e ADMIN_PASSWORD antes de iniciar o sistema.');
  }
  const existing = await pool.query('SELECT id FROM usuarios WHERE email = $1 LIMIT 1', [adminEmail]);
  if (existing.rowCount === 0) {
    await pool.query(
      'INSERT INTO usuarios (nome,email,senha,perfil) VALUES ($1,$2,$3,$4)',
      ['Administrador', adminEmail, hashPassword(adminPassword), 'admin']
    );
  }
}

initDatabase().then(()=>app.listen(PORT,()=>console.log(`LogiControl V8 Mobile: http://localhost:${PORT}`))).catch(err=>{console.error('Falha ao inicializar banco:',err);process.exit(1);})
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return password === stored; // migration fallback
  const [salt, key] = stored.split(':');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key,'hex'), Buffer.from(derived,'hex'));
}

;