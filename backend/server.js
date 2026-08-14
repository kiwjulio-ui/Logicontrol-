const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");
const { Pool } = require("pg");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) console.warn("AVISO: JWT_SECRET não definido. Defina-o no Render antes de produção.");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000
});

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "..")));

const q = (text, params=[]) => pool.query(text, params);
const one = async (text, params=[]) => { const r = await q(text, params); return r.rows[0] || null; };
const many = async (text, params=[]) => (await q(text, params)).rows;

async function transaction(fn) {
  const client = await pool.connect();
  try { await client.query("BEGIN"); const out = await fn(client); await client.query("COMMIT"); return out; }
  catch (e) { try { await client.query("ROLLBACK"); } catch {} throw e; }
  finally { client.release(); }
}

async function initDatabase() {
  await q(`CREATE TABLE IF NOT EXISTS usuarios (
    id SERIAL PRIMARY KEY, nome TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    senha_hash TEXT NOT NULL, tipo TEXT NOT NULL DEFAULT 'operador' CHECK(tipo IN ('admin','operador')),
    ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS clientes (
    id SERIAL PRIMARY KEY, nome TEXT NOT NULL, cidade TEXT NOT NULL, endereco TEXT NOT NULL,
    telefone TEXT, email TEXT, documento TEXT, ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS produtos (
    id SERIAL PRIMARY KEY, nome TEXT NOT NULL, categoria TEXT NOT NULL DEFAULT 'Sem categoria', sku TEXT UNIQUE,
    quantidade INTEGER NOT NULL DEFAULT 0 CHECK(quantidade >= 0), estoque_minimo INTEGER NOT NULL DEFAULT 0 CHECK(estoque_minimo >= 0),
    preco_padrao NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK(preco_padrao >= 0), ativo BOOLEAN NOT NULL DEFAULT TRUE, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS pedidos (
    id SERIAL PRIMARY KEY, cliente_id INTEGER NOT NULL REFERENCES clientes(id), usuario_id INTEGER REFERENCES usuarios(id),
    status TEXT NOT NULL DEFAULT 'Pendente', prioridade TEXT NOT NULL DEFAULT 'Normal', observacoes TEXT,
    valor_total NUMERIC(14,2) NOT NULL DEFAULT 0, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(), atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS itens_pedido (
    id SERIAL PRIMARY KEY, pedido_id INTEGER NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE, produto_id INTEGER NOT NULL REFERENCES produtos(id),
    quantidade INTEGER NOT NULL CHECK(quantidade > 0), preco_unitario NUMERIC(14,2) NOT NULL CHECK(preco_unitario >= 0), subtotal NUMERIC(14,2) NOT NULL CHECK(subtotal >= 0)
  )`);
  await q(`CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
    id SERIAL PRIMARY KEY, produto_id INTEGER NOT NULL REFERENCES produtos(id), tipo TEXT NOT NULL,
    quantidade INTEGER NOT NULL CHECK(quantidade > 0), saldo_anterior INTEGER NOT NULL, saldo_posterior INTEGER NOT NULL,
    motivo TEXT NOT NULL, pedido_id INTEGER REFERENCES pedidos(id), usuario_id INTEGER REFERENCES usuarios(id), criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS motoristas (
    id SERIAL PRIMARY KEY, nome TEXT NOT NULL, telefone TEXT, cnh TEXT, status TEXT NOT NULL DEFAULT 'Disponível', ativo BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  await q(`CREATE TABLE IF NOT EXISTS veiculos (
    id SERIAL PRIMARY KEY, placa TEXT NOT NULL UNIQUE, modelo TEXT NOT NULL, capacidade_kg NUMERIC(12,2) DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'Disponível', ativo BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  await q(`CREATE TABLE IF NOT EXISTS entregas (
    id SERIAL PRIMARY KEY, pedido_id INTEGER NOT NULL UNIQUE REFERENCES pedidos(id), motorista_id INTEGER REFERENCES motoristas(id),
    veiculo_id INTEGER REFERENCES veiculos(id), origem TEXT, destino TEXT, data_prevista TIMESTAMPTZ, data_saida TIMESTAMPTZ,
    data_conclusao TIMESTAMPTZ, status TEXT NOT NULL DEFAULT 'Aguardando', observacoes TEXT
  )`);
  await q(`CREATE TABLE IF NOT EXISTS custos (
    id SERIAL PRIMARY KEY, entrega_id INTEGER REFERENCES entregas(id), tipo TEXT NOT NULL, descricao TEXT,
    valor NUMERIC(14,2) NOT NULL CHECK(valor >= 0), criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE TABLE IF NOT EXISTS auditoria (
    id SERIAL PRIMARY KEY, usuario_id INTEGER REFERENCES usuarios(id), acao TEXT NOT NULL, entidade TEXT,
    entidade_id INTEGER, detalhes TEXT, criado_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await q(`CREATE INDEX IF NOT EXISTS idx_pedidos_status ON pedidos(status)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_mov_produto ON movimentacoes_estoque(produto_id)`);
  await q(`CREATE INDEX IF NOT EXISTS idx_entregas_status ON entregas(status)`);

  const count = await one("SELECT COUNT(*)::int AS n FROM usuarios");
  if (count.n === 0) {
    const hash = await bcrypt.hash("1234", 12);
    await q("INSERT INTO usuarios(nome,email,senha_hash,tipo) VALUES($1,$2,$3,'admin')", ["Administrador", "admin@logicontrol.local", hash]);
    console.log("Usuário inicial criado: admin@logicontrol.local / 1234");
  }
}

function auth(req,res,next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ erro: "Não autenticado." });
  try { req.user = jwt.verify(token, JWT_SECRET || "invalid-secret"); next(); }
  catch { return res.status(401).json({ erro: "Sessão inválida ou expirada." }); }
}
function admin(req,res,next) { if (req.user.tipo !== "admin") return res.status(403).json({ erro: "Acesso restrito ao administrador." }); next(); }
function bad(res,msg) { return res.status(400).json({ erro: msg }); }
async function audit(user, acao, entidade, id, detalhes="", client=null) {
  const db = client || { query: q };
  await db.query("INSERT INTO auditoria(usuario_id,acao,entidade,entidade_id,detalhes) VALUES($1,$2,$3,$4,$5)", [user?.id || null, acao, entidade, id || null, detalhes || null]);
}
const PED_STATUS = ["Pendente","Em preparação","Em transporte","Entregue","Cancelado"];
const ENT_STATUS = ["Aguardando","Em preparação","Em transporte","Concluída","Cancelada"];

app.get("/api", (req,res)=>res.json({ sistema:"LogiControl", versao:"V8.1", status:"online" }));
app.get("/health", async (req,res)=>{ try { await q("SELECT 1"); res.json({status:"ok", banco:"PostgreSQL", versao:"V8.1"}); } catch(e) { res.status(503).json({status:"erro",erro:e.message}); } });

app.post("/auth/login", async (req,res)=>{
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const senha = String(req.body.senha || "");
    const u = await one("SELECT * FROM usuarios WHERE LOWER(email)=LOWER($1) AND ativo=true", [email]);
    if (!u || !(await bcrypt.compare(senha,u.senha_hash))) return res.status(401).json({erro:"E-mail ou senha inválidos."});
    const token = jwt.sign({id:u.id,nome:u.nome,email:u.email,tipo:u.tipo}, JWT_SECRET || "invalid-secret", {expiresIn:"8h"});
    await audit(u,"LOGIN","usuarios",u.id);
    res.json({token,usuario:{id:u.id,nome:u.nome,email:u.email,tipo:u.tipo}});
  } catch(e) { res.status(500).json({erro:"Falha no login."}); }
});
app.get("/auth/me", auth, async (req,res)=>{ const u=await one("SELECT id,nome,email,tipo,ativo FROM usuarios WHERE id=$1",[req.user.id]); if(!u||!u.ativo)return res.status(401).json({erro:"Usuário inativo."}); res.json(u); });
app.post("/auth/change-password", auth, async (req,res)=>{
  try {
    const atual=String(req.body.senha_atual||""), nova=String(req.body.nova_senha||"");
    if(nova.length<6)return bad(res,"A nova senha deve ter pelo menos 6 caracteres.");
    if(nova===atual)return bad(res,"A nova senha deve ser diferente da senha atual.");
    const u=await one("SELECT * FROM usuarios WHERE id=$1 AND ativo=true",[req.user.id]);
    if(!u || !(await bcrypt.compare(atual,u.senha_hash)))return res.status(400).json({erro:"Senha atual incorreta."});
    const hash=await bcrypt.hash(nova,12); await q("UPDATE usuarios SET senha_hash=$1,atualizado_em=NOW() WHERE id=$2",[hash,u.id]); await audit(req.user,"ALTERAR_SENHA","usuarios",u.id); res.json({ok:true,mensagem:"Senha alterada com sucesso."});
  }catch(e){res.status(500).json({erro:"Não foi possível alterar a senha."});}
});

app.get("/dashboard",auth,async(req,res)=>{try{
  const [p,c,pe,pend,bx,en,valor,custos]=await Promise.all([
    one("SELECT COUNT(*)::int n FROM produtos WHERE ativo=true"), one("SELECT COUNT(*)::int n FROM clientes WHERE ativo=true"),
    one("SELECT COUNT(*)::int n FROM pedidos"), one("SELECT COUNT(*)::int n FROM pedidos WHERE status NOT IN ('Entregue','Cancelado')"),
    one("SELECT COUNT(*)::int n FROM produtos WHERE ativo=true AND quantidade<=estoque_minimo"), one("SELECT COUNT(*)::int n FROM entregas WHERE status NOT IN ('Concluída','Cancelada')"),
    one("SELECT COALESCE(SUM(valor_total),0) n FROM pedidos WHERE status<>'Cancelado'"), one("SELECT COALESCE(SUM(valor),0) n FROM custos")
  ]);
  res.json({produtos:p.n,clientes:c.n,pedidos:pe.n,pendentes:pend.n,estoque_baixo:bx.n,entregas_ativas:en.n,valor_pedidos:Number(valor.n),custos:Number(custos.n)});
}catch(e){res.status(500).json({erro:e.message})}});

app.get("/produtos",auth,async(req,res)=>{try{res.json(await many("SELECT p.*,CASE WHEN quantidade<=estoque_minimo THEN 1 ELSE 0 END estoque_baixo FROM produtos p WHERE ativo=true ORDER BY id DESC"))}catch(e){res.status(500).json({erro:e.message})}});
app.post("/produtos",auth,async(req,res)=>{try{
 const nome=String(req.body.nome||"").trim(), categoria=String(req.body.categoria||"Sem categoria").trim(), sku=req.body.sku?String(req.body.sku).trim():null;
 const quantidade=Number(req.body.quantidade||0), minimo=Number(req.body.estoque_minimo||0), preco=Number(req.body.preco_padrao||0);
 if(!nome||!Number.isInteger(quantidade)||quantidade<0||!Number.isInteger(minimo)||minimo<0||!Number.isFinite(preco)||preco<0)return bad(res,"Dados do produto inválidos.");
 const id=await transaction(async(client)=>{const r=await client.query("INSERT INTO produtos(nome,categoria,sku,quantidade,estoque_minimo,preco_padrao) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[nome,categoria,sku,quantidade,minimo,preco]);const id=r.rows[0].id;if(quantidade>0)await client.query("INSERT INTO movimentacoes_estoque(produto_id,tipo,quantidade,saldo_anterior,saldo_posterior,motivo,usuario_id) VALUES($1,'ENTRADA',$2,0,$2,'Cadastro inicial',$3)",[id,quantidade,req.user.id]);await audit(req.user,"CRIAR","produtos",id,nome,client);return id;});
 res.status(201).json(await one("SELECT * FROM produtos WHERE id=$1",[id]));
}catch(e){res.status(400).json({erro:e.code==='23505'?"SKU já cadastrado.":e.message})}});
app.post("/produtos/:id/entrada",auth,async(req,res)=>{try{const qtd=Number(req.body.quantidade);if(!Number.isInteger(qtd)||qtd<=0)return bad(res,"Quantidade inválida.");const p=await transaction(async(client)=>{const r=await client.query("SELECT * FROM produtos WHERE id=$1 AND ativo=true FOR UPDATE",[req.params.id]);if(!r.rows[0])throw Error("Produto não encontrado.");const x=r.rows[0];await client.query("UPDATE produtos SET quantidade=quantidade+$1 WHERE id=$2",[qtd,x.id]);await client.query("INSERT INTO movimentacoes_estoque(produto_id,tipo,quantidade,saldo_anterior,saldo_posterior,motivo,usuario_id) VALUES($1,'ENTRADA',$2,$3,$4,$5,$6)",[x.id,qtd,x.quantidade,x.quantidade+qtd,req.body.motivo||"Entrada manual",req.user.id]);return x.id;});res.json(await one("SELECT * FROM produtos WHERE id=$1",[p]));}catch(e){res.status(400).json({erro:e.message})}});
app.get("/estoque/movimentacoes",auth,async(req,res)=>{try{res.json(await many("SELECT m.*,p.nome produto_nome,u.nome usuario_nome FROM movimentacoes_estoque m JOIN produtos p ON p.id=m.produto_id LEFT JOIN usuarios u ON u.id=m.usuario_id ORDER BY m.id DESC LIMIT 500"))}catch(e){res.status(500).json({erro:e.message})}});

app.get("/clientes",auth,async(req,res)=>{try{res.json(await many("SELECT * FROM clientes WHERE ativo=true ORDER BY id DESC"))}catch(e){res.status(500).json({erro:e.message})}});
app.post("/clientes",auth,async(req,res)=>{try{const {nome,cidade,endereco,telefone,email,documento}=req.body;if(!nome||!cidade||!endereco)return bad(res,"Nome, cidade e endereço são obrigatórios.");const r=await q("INSERT INTO clientes(nome,cidade,endereco,telefone,email,documento) VALUES($1,$2,$3,$4,$5,$6) RETURNING *",[nome,cidade,endereco,telefone||null,email||null,documento||null]);await audit(req.user,"CRIAR","clientes",r.rows[0].id,nome);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({erro:e.message})}});

app.get("/pedidos",auth,async(req,res)=>{try{res.json(await many("SELECT p.*,c.nome cliente_nome FROM pedidos p JOIN clientes c ON c.id=p.cliente_id ORDER BY p.id DESC"))}catch(e){res.status(500).json({erro:e.message})}});
app.get("/pedidos/:id",auth,async(req,res)=>{try{const p=await one("SELECT p.*,c.nome cliente_nome FROM pedidos p JOIN clientes c ON c.id=p.cliente_id WHERE p.id=$1",[req.params.id]);if(!p)return res.status(404).json({erro:"Pedido não encontrado."});p.itens=await many("SELECT i.*,pr.nome produto_nome,pr.sku FROM itens_pedido i JOIN produtos pr ON pr.id=i.produto_id WHERE i.pedido_id=$1",[p.id]);res.json(p);}catch(e){res.status(500).json({erro:e.message})}});
app.post("/pedidos",auth,async(req,res)=>{try{
 const cliente=Number(req.body.cliente_id), status=req.body.status||"Pendente", prioridade=req.body.prioridade||"Normal", itens=req.body.itens;
 if(!Number.isInteger(cliente)||!Array.isArray(itens)||!itens.length)return bad(res,"Cliente e itens são obrigatórios.");if(!PED_STATUS.includes(status))return bad(res,"Status inválido.");
 const id=await transaction(async(clientDb)=>{if(!(await clientDb.query("SELECT id FROM clientes WHERE id=$1 AND ativo=true",[cliente])).rows[0])throw Error("Cliente não existe.");let total=0,linhas=[];
  for(const item of itens){const produtoId=Number(item.produto_id), qtd=Number(item.quantidade);if(!Number.isInteger(produtoId)||!Number.isInteger(qtd)||qtd<=0)throw Error("Item inválido.");const r=await clientDb.query("SELECT * FROM produtos WHERE id=$1 AND ativo=true FOR UPDATE",[produtoId]);const p=r.rows[0];if(!p)throw Error("Produto não encontrado.");if(p.quantidade<qtd)throw Error(`Estoque insuficiente para ${p.nome}. Disponível: ${p.quantidade}.`);const preco=item.preco_unitario===""||item.preco_unitario==null?Number(p.preco_padrao):Number(item.preco_unitario);if(!Number.isFinite(preco)||preco<0)throw Error("Preço inválido.");const sub=qtd*preco;total+=sub;linhas.push({p,qtd,preco,sub});}
  const pr=await clientDb.query("INSERT INTO pedidos(cliente_id,usuario_id,status,prioridade,observacoes,valor_total) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",[cliente,req.user.id,status,prioridade,req.body.observacoes||null,total]);const pedidoId=pr.rows[0].id;
  for(const l of linhas){await clientDb.query("INSERT INTO itens_pedido(pedido_id,produto_id,quantidade,preco_unitario,subtotal) VALUES($1,$2,$3,$4,$5)",[pedidoId,l.p.id,l.qtd,l.preco,l.sub]);await clientDb.query("UPDATE produtos SET quantidade=quantidade-$1 WHERE id=$2",[l.qtd,l.p.id]);await clientDb.query("INSERT INTO movimentacoes_estoque(produto_id,tipo,quantidade,saldo_anterior,saldo_posterior,motivo,pedido_id,usuario_id) VALUES($1,'SAIDA',$2,$3,$4,$5,$6,$7)",[l.p.id,l.qtd,l.p.quantidade,l.p.quantidade-l.qtd,`Pedido #${pedidoId}`,pedidoId,req.user.id]);}
  await audit(req.user,"CRIAR","pedidos",pedidoId,`Total ${total.toFixed(2)}`,clientDb);return pedidoId;
 });res.status(201).json(await one("SELECT * FROM pedidos WHERE id=$1",[id]));
}catch(e){res.status(400).json({erro:e.message})}});
app.patch("/pedidos/:id/status",auth,async(req,res)=>{try{const status=req.body.status;if(!PED_STATUS.includes(status))return bad(res,"Status inválido.");const r=await q("UPDATE pedidos SET status=$1,atualizado_em=NOW() WHERE id=$2 RETURNING *",[status,req.params.id]);if(!r.rows[0])return res.status(404).json({erro:"Pedido não encontrado."});await audit(req.user,"STATUS","pedidos",Number(req.params.id),status);res.json(r.rows[0]);}catch(e){res.status(400).json({erro:e.message})}});

app.get("/motoristas",auth,async(req,res)=>{try{res.json(await many("SELECT * FROM motoristas WHERE ativo=true ORDER BY id DESC"))}catch(e){res.status(500).json({erro:e.message})}});
app.post("/motoristas",auth,async(req,res)=>{try{if(!req.body.nome)return bad(res,"Nome obrigatório.");const r=await q("INSERT INTO motoristas(nome,telefone,cnh,status) VALUES($1,$2,$3,$4) RETURNING *",[req.body.nome,req.body.telefone||null,req.body.cnh||null,req.body.status||"Disponível"]);await audit(req.user,"CRIAR","motoristas",r.rows[0].id,req.body.nome);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({erro:e.message})}});
app.get("/veiculos",auth,async(req,res)=>{try{res.json(await many("SELECT * FROM veiculos WHERE ativo=true ORDER BY id DESC"))}catch(e){res.status(500).json({erro:e.message})}});
app.post("/veiculos",auth,async(req,res)=>{try{const placa=String(req.body.placa||"").trim().toUpperCase(),modelo=String(req.body.modelo||"").trim();if(!placa||!modelo)return bad(res,"Placa e modelo obrigatórios.");const cap=Number(req.body.capacidade_kg||0);if(!Number.isFinite(cap)||cap<0)return bad(res,"Capacidade inválida.");const r=await q("INSERT INTO veiculos(placa,modelo,capacidade_kg,status) VALUES($1,$2,$3,$4) RETURNING *",[placa,modelo,cap,req.body.status||"Disponível"]);await audit(req.user,"CRIAR","veiculos",r.rows[0].id,placa);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({erro:e.code==='23505'?"Placa já cadastrada.":e.message})}});

app.get("/entregas",auth,async(req,res)=>{try{res.json(await many(`SELECT e.*,p.valor_total,c.nome cliente_nome,m.nome motorista_nome,v.placa veiculo_placa FROM entregas e JOIN pedidos p ON p.id=e.pedido_id JOIN clientes c ON c.id=p.cliente_id LEFT JOIN motoristas m ON m.id=e.motorista_id LEFT JOIN veiculos v ON v.id=e.veiculo_id ORDER BY e.id DESC`))}catch(e){res.status(500).json({erro:e.message})}});
app.post("/entregas",auth,async(req,res)=>{try{const pedidoId=Number(req.body.pedido_id);if(!Number.isInteger(pedidoId)||!req.body.destino)return bad(res,"Pedido e destino obrigatórios.");if(await one("SELECT id FROM entregas WHERE pedido_id=$1",[pedidoId]))return bad(res,"Este pedido já possui uma entrega.");const r=await q("INSERT INTO entregas(pedido_id,motorista_id,veiculo_id,origem,destino,data_prevista,observacoes) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *",[pedidoId,req.body.motorista_id||null,req.body.veiculo_id||null,req.body.origem||null,req.body.destino,req.body.data_prevista||null,req.body.observacoes||null]);await audit(req.user,"CRIAR","entregas",r.rows[0].id);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({erro:e.message})}});
app.patch("/entregas/:id/status",auth,async(req,res)=>{try{const status=req.body.status;if(!ENT_STATUS.includes(status))return bad(res,"Status inválido.");let sql="UPDATE entregas SET status=$1";const params=[status];if(status==="Em transporte")sql+=",data_saida=NOW()";if(status==="Concluída")sql+=",data_conclusao=NOW()";sql+=" WHERE id=$2 RETURNING *";params.push(req.params.id);const r=await q(sql,params);if(!r.rows[0])return res.status(404).json({erro:"Entrega não encontrada."});await audit(req.user,"STATUS","entregas",Number(req.params.id),status);res.json(r.rows[0]);}catch(e){res.status(400).json({erro:e.message})}});

app.get("/custos",auth,async(req,res)=>{try{res.json(await many("SELECT c.*,e.pedido_id FROM custos c LEFT JOIN entregas e ON e.id=c.entrega_id ORDER BY c.id DESC"))}catch(e){res.status(500).json({erro:e.message})}});
app.post("/custos",auth,async(req,res)=>{try{const valor=Number(req.body.valor);if(!req.body.tipo||!Number.isFinite(valor)||valor<0)return bad(res,"Tipo e valor inválidos.");const r=await q("INSERT INTO custos(entrega_id,tipo,descricao,valor) VALUES($1,$2,$3,$4) RETURNING *",[req.body.entrega_id||null,req.body.tipo,req.body.descricao||null,valor]);await audit(req.user,"CRIAR","custos",r.rows[0].id);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({erro:e.message})}});
app.get("/relatorios/resumo",auth,async(req,res)=>{try{const [pedidos,estoque,custos,ticket]=await Promise.all([many("SELECT status,COUNT(*)::int quantidade,COALESCE(SUM(valor_total),0) valor FROM pedidos GROUP BY status ORDER BY status"),many("SELECT id,nome,quantidade,estoque_minimo FROM produtos WHERE ativo=true AND quantidade<=estoque_minimo ORDER BY quantidade ASC"),one("SELECT COALESCE(SUM(valor),0) total FROM custos"),one("SELECT COALESCE(AVG(valor_total),0) medio FROM pedidos WHERE status<>'Cancelado'")]);res.json({pedidos,estoque_baixo:estoque,custos_total:Number(custos.total),ticket_medio:Number(ticket.medio)});}catch(e){res.status(500).json({erro:e.message})}});

app.get("/usuarios",auth,admin,async(req,res)=>{try{res.json(await many("SELECT id,nome,email,tipo,ativo,criado_em FROM usuarios ORDER BY id DESC"))}catch(e){res.status(500).json({erro:e.message})}});
app.post("/usuarios",auth,admin,async(req,res)=>{try{const nome=String(req.body.nome||"").trim(),email=String(req.body.email||"").trim().toLowerCase(),senha=String(req.body.senha||""),tipo=req.body.tipo==="admin"?"admin":"operador";if(!nome||!email||senha.length<6)return bad(res,"Nome, e-mail e senha (mínimo 6 caracteres) são obrigatórios.");const hash=await bcrypt.hash(senha,12);const r=await q("INSERT INTO usuarios(nome,email,senha_hash,tipo) VALUES($1,$2,$3,$4) RETURNING id,nome,email,tipo,ativo",[nome,email,hash,tipo]);await audit(req.user,"CRIAR","usuarios",r.rows[0].id,email);res.status(201).json(r.rows[0]);}catch(e){res.status(400).json({erro:e.code==='23505'?"E-mail já cadastrado.":e.message})}});
app.patch("/usuarios/:id/status",auth,admin,async(req,res)=>{try{const id=Number(req.params.id);if(id===req.user.id)return bad(res,"Você não pode desativar sua própria conta.");const ativo=Boolean(req.body.ativo);const r=await q("UPDATE usuarios SET ativo=$1,atualizado_em=NOW() WHERE id=$2 RETURNING id,nome,email,tipo,ativo",[ativo,id]);if(!r.rows[0])return res.status(404).json({erro:"Usuário não encontrado."});await audit(req.user,"STATUS","usuarios",id,ativo?"Ativado":"Desativado");res.json(r.rows[0]);}catch(e){res.status(400).json({erro:e.message})}});
app.post("/usuarios/:id/reset-password",auth,admin,async(req,res)=>{try{const senha=String(req.body.nova_senha||"");if(senha.length<6)return bad(res,"A nova senha deve ter pelo menos 6 caracteres.");const id=Number(req.params.id);const hash=await bcrypt.hash(senha,12);const r=await q("UPDATE usuarios SET senha_hash=$1,atualizado_em=NOW() WHERE id=$2 RETURNING id",[hash,id]);if(!r.rows[0])return res.status(404).json({erro:"Usuário não encontrado."});await audit(req.user,"RESET_SENHA","usuarios",id);res.json({ok:true,mensagem:"Senha redefinida."});}catch(e){res.status(400).json({erro:e.message})}});
app.get("/auditoria",auth,admin,async(req,res)=>{try{res.json(await many("SELECT a.*,u.nome usuario_nome FROM auditoria a LEFT JOIN usuarios u ON u.id=a.usuario_id ORDER BY a.id DESC LIMIT 500"))}catch(e){res.status(500).json({erro:e.message})}});

app.use((err,req,res,next)=>{console.error(err);res.status(500).json({erro:"Erro interno do servidor."});});
app.get("*",(req,res)=>{ if(req.path.startsWith("/auth")||req.path.startsWith("/dashboard")||req.path.startsWith("/produtos")||req.path.startsWith("/clientes")||req.path.startsWith("/pedidos")||req.path.startsWith("/estoque")||req.path.startsWith("/motoristas")||req.path.startsWith("/veiculos")||req.path.startsWith("/entregas")||req.path.startsWith("/custos")||req.path.startsWith("/relatorios")||req.path.startsWith("/usuarios")||req.path.startsWith("/auditoria")||req.path.startsWith("/health")||req.path==="/api") return res.status(404).json({erro:"Rota não encontrada."}); res.sendFile(path.join(__dirname,"..","index.html")); });

initDatabase().then(()=>app.listen(PORT,()=>console.log(`LogiControl V8.1 online na porta ${PORT}`))).catch(e=>{console.error("Falha ao iniciar banco:",e);process.exit(1)});
