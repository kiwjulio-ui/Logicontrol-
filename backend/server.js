const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const JWT_SECRET =
  process.env.JWT_SECRET || "CHANGE-ME-IN-PRODUCTION";

const DB_FILE =
  process.env.DB_FILE || "./logicontrol.db";

const db = new sqlite3.Database(DB_FILE);

/* =========================================================
   EXPRESS
========================================================= */

app.use(cors());

app.use(
  express.json({
    limit: "1mb"
  })
);

app.use(
  express.static(
    path.join(__dirname, "..")
  )
);

/* =========================================================
   SQLITE HELPERS
========================================================= */

const run = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        reject(err);
        return;
      }

      resolve({
        id: this.lastID,
        changes: this.changes
      });
    });
  });

const get = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(row);
    });
  });

const all = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        reject(err);
        return;
      }

      resolve(rows);
    });
  });

async function tx(fn) {
  await run("BEGIN IMMEDIATE");

  try {
    const result = await fn();

    await run("COMMIT");

    return result;
  } catch (err) {
    try {
      await run("ROLLBACK");
    } catch (_) {}

    throw err;
  }
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initDatabase() {
  await run("PRAGMA foreign_keys = ON");

  /* -------------------------------------------------------
     USUARIOS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      senha_hash TEXT NOT NULL,
      tipo TEXT NOT NULL DEFAULT 'operador',
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* -------------------------------------------------------
     CLIENTES
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS clientes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cidade TEXT NOT NULL,
      endereco TEXT NOT NULL,
      telefone TEXT,
      email TEXT,
      documento TEXT,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* -------------------------------------------------------
     PRODUTOS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS produtos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      categoria TEXT NOT NULL DEFAULT 'Sem categoria',
      sku TEXT UNIQUE,
      quantidade INTEGER NOT NULL DEFAULT 0
        CHECK (quantidade >= 0),
      estoque_minimo INTEGER NOT NULL DEFAULT 0
        CHECK (estoque_minimo >= 0),
      preco_padrao REAL NOT NULL DEFAULT 0
        CHECK (preco_padrao >= 0),
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* -------------------------------------------------------
     PEDIDOS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id INTEGER NOT NULL,
      usuario_id INTEGER,
      status TEXT NOT NULL DEFAULT 'Pendente',
      prioridade TEXT NOT NULL DEFAULT 'Normal',
      observacoes TEXT,
      valor_total REAL NOT NULL DEFAULT 0
        CHECK (valor_total >= 0),
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (cliente_id)
        REFERENCES clientes(id),

      FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id)
    )
  `);

  /* -------------------------------------------------------
     ITENS DOS PEDIDOS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS itens_pedido (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      produto_id INTEGER NOT NULL,
      quantidade INTEGER NOT NULL
        CHECK (quantidade > 0),
      preco_unitario REAL NOT NULL
        CHECK (preco_unitario >= 0),
      subtotal REAL NOT NULL
        CHECK (subtotal >= 0),

      FOREIGN KEY (pedido_id)
        REFERENCES pedidos(id)
        ON DELETE CASCADE,

      FOREIGN KEY (produto_id)
        REFERENCES produtos(id)
    )
  `);

  /* -------------------------------------------------------
     MOVIMENTAÇÕES DE ESTOQUE
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS movimentacoes_estoque (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      produto_id INTEGER NOT NULL,
      tipo TEXT NOT NULL,
      quantidade INTEGER NOT NULL
        CHECK (quantidade > 0),
      saldo_anterior INTEGER NOT NULL,
      saldo_posterior INTEGER NOT NULL,
      motivo TEXT NOT NULL,
      pedido_id INTEGER,
      usuario_id INTEGER,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (produto_id)
        REFERENCES produtos(id),

      FOREIGN KEY (pedido_id)
        REFERENCES pedidos(id),

      FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id)
    )
  `);

  /* -------------------------------------------------------
     MOTORISTAS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS motoristas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      telefone TEXT,
      cnh TEXT,
      status TEXT NOT NULL DEFAULT 'Disponível',
      ativo INTEGER NOT NULL DEFAULT 1
    )
  `);

  /* -------------------------------------------------------
     VEÍCULOS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS veiculos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      placa TEXT NOT NULL UNIQUE,
      modelo TEXT NOT NULL,
      capacidade_kg REAL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'Disponível',
      ativo INTEGER NOT NULL DEFAULT 1
    )
  `);

  /* -------------------------------------------------------
     ENTREGAS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS entregas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL UNIQUE,
      motorista_id INTEGER,
      veiculo_id INTEGER,
      origem TEXT,
      destino TEXT,
      data_prevista TEXT,
      data_saida TEXT,
      data_conclusao TEXT,
      status TEXT NOT NULL DEFAULT 'Aguardando',
      observacoes TEXT,

      FOREIGN KEY (pedido_id)
        REFERENCES pedidos(id),

      FOREIGN KEY (motorista_id)
        REFERENCES motoristas(id),

      FOREIGN KEY (veiculo_id)
        REFERENCES veiculos(id)
    )
  `);

  /* -------------------------------------------------------
     CUSTOS
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS custos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entrega_id INTEGER,
      tipo TEXT NOT NULL,
      descricao TEXT,
      valor REAL NOT NULL
        CHECK (valor >= 0),
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (entrega_id)
        REFERENCES entregas(id)
    )
  `);

  /* -------------------------------------------------------
     AUDITORIA
  ------------------------------------------------------- */

  await run(`
    CREATE TABLE IF NOT EXISTS auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      acao TEXT NOT NULL,
      entidade TEXT,
      entidade_id INTEGER,
      detalhes TEXT,
      criado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,

      FOREIGN KEY (usuario_id)
        REFERENCES usuarios(id)
    )
  `);

  /* -------------------------------------------------------
     ÍNDICES
  ------------------------------------------------------- */

  await run(`
    CREATE INDEX IF NOT EXISTS
    idx_pedidos_status
    ON pedidos(status)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS
    idx_mov_produto
    ON movimentacoes_estoque(produto_id)
  `);

  await run(`
    CREATE INDEX IF NOT EXISTS
    idx_entregas_status
    ON entregas(status)
  `);

  /* -------------------------------------------------------
     USUÁRIO ADMINISTRADOR INICIAL
  ------------------------------------------------------- */

  const usuario = await get(
    "SELECT COUNT(*) AS n FROM usuarios"
  );

  if (usuario.n === 0) {
    const senhaHash = bcrypt.hashSync(
      "1234",
      10
    );

    await run(
      `
      INSERT INTO usuarios
      (
        nome,
        email,
        senha_hash,
        tipo
      )
      VALUES (?, ?, ?, ?)
      `,
      [
        "Administrador",
        "admin@logicontrol.local",
        senhaHash,
        "admin"
      ]
    );

    console.log(
      "Usuário administrador inicial criado."
    );
  }

  console.log(
    "Banco de dados inicializado com sucesso."
  );
}

/* =========================================================
   AUTHENTICATION
========================================================= */

function auth(req, res, next) {
  const header =
    req.headers.authorization || "";

  const token =
    header.startsWith("Bearer ")
      ? header.slice(7)
      : null;

  if (!token) {
    return res.status(401).json({
      erro: "Não autenticado."
    });
  }

  try {
    req.user = jwt.verify(
      token,
      JWT_SECRET
    );

    next();
  } catch (err) {
    return res.status(401).json({
      erro: "Sessão inválida ou expirada."
    });
  }
}

/* =========================================================
   ADMIN MIDDLEWARE
========================================================= */

function admin(req, res, next) {
  if (!req.user || req.user.tipo !== "admin") {
    return res.status(403).json({
      erro: "Acesso restrito ao administrador."
    });
  }

  next();
}

/* =========================================================
   AUDIT
========================================================= */

function audit(
  user,
  acao,
  entidade,
  id,
  detalhes = ""
) {
  return run(
    `
    INSERT INTO auditoria
    (
      usuario_id,
      acao,
      entidade,
      entidade_id,
      detalhes
    )
    VALUES (?, ?, ?, ?, ?)
    `,
    [
      user?.id || null,
      acao,
      entidade,
      id,
      detalhes
    ]
  );
}

/* =========================================================
   ERROR HELPER
========================================================= */

function bad(res, msg) {
  return res.status(400).json({
    erro: msg
  });
}

/* =========================================================
   STATUS DOS PEDIDOS
========================================================= */

const okStatuses = [
  "Pendente",
  "Em preparação",
  "Em transporte",
  "Entregue",
  "Cancelado"
];

/* =========================================================
   API
========================================================= */

app.get("/api", (req, res) => {
  res.json({
    sistema: "LogiControl",
    versao: "V8 Simplificada",
    status: "online"
  });
});

/* =========================================================
   HEALTH CHECK
========================================================= */

app.get(
  "/health",
  async (req, res) => {
    try {
      await get("SELECT 1 AS ok");

      res.json({
        status: "ok",
        banco: "online",
        versao: "V8"
      });
    } catch (err) {
      res.status(503).json({
        status: "erro",
        erro: err.message
      });
    }
  }
);

/* =========================================================
   LOGIN
========================================================= */

app.post(
  "/auth/login",
  async (req, res) => {
    try {
      const {
        email,
        senha
      } = req.body;

      const usuario = await get(
        `
        SELECT *
        FROM usuarios
        WHERE email = ?
          AND ativo = 1
        `,
        [email]
      );

      if (
        !usuario ||
        !bcrypt.compareSync(
          senha || "",
          usuario.senha_hash
        )
      ) {
        return res.status(401).json({
          erro: "E-mail ou senha inválidos."
        });
      }

      const token = jwt.sign(
        {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          tipo: usuario.tipo
        },
        JWT_SECRET,
        {
          expiresIn: "8h"
        }
      );

      await audit(
        usuario,
        "LOGIN",
        "usuarios",
        usuario.id
      );

      res.json({
        token,
        usuario: {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          tipo: usuario.tipo
        }
      });
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   DASHBOARD
========================================================= */

app.get(
  "/dashboard",
  auth,
  async (req, res) => {
    try {
      const [
        produtos,
        clientes,
        pedidos,
        pendentes,
        estoqueBaixo,
        entregasAtivas,
        valorPedidos,
        custos
      ] = await Promise.all([
        get(
          `
          SELECT COUNT(*) AS n
          FROM produtos
          WHERE ativo = 1
          `
        ),

        get(
          `
          SELECT COUNT(*) AS n
          FROM clientes
          WHERE ativo = 1
          `
        ),

        get(
          `
          SELECT COUNT(*) AS n
          FROM pedidos
          `
        ),

        get(
          `
          SELECT COUNT(*) AS n
          FROM pedidos
          WHERE status NOT IN
          ('Entregue', 'Cancelado')
          `
        ),

        get(
          `
          SELECT COUNT(*) AS n
          FROM produtos
          WHERE ativo = 1
            AND quantidade <= estoque_minimo
          `
        ),

        get(
          `
          SELECT COUNT(*) AS n
          FROM entregas
          WHERE status NOT IN
          ('Concluída', 'Cancelada')
          `
        ),

        get(
          `
          SELECT COALESCE(
            SUM(valor_total), 0
          ) AS n
          FROM pedidos
          WHERE status <> 'Cancelado'
          `
        ),

        get(
          `
          SELECT COALESCE(
            SUM(valor), 0
          ) AS n
          FROM custos
          `
        )
      ]);

      res.json({
        produtos: produtos.n,
        clientes: clientes.n,
        pedidos: pedidos.n,
        pendentes: pendentes.n,
        estoque_baixo: estoqueBaixo.n,
        entregas_ativas: entregasAtivas.n,
        valor_pedidos: valorPedidos.n,
        custos: custos.n
      });
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   PRODUTOS
========================================================= */

app.get(
  "/produtos",
  auth,
  async (req, res) => {
    try {
      const produtos = await all(`
        SELECT
          p.*,
          CASE
            WHEN quantidade <= estoque_minimo
            THEN 1
            ELSE 0
          END AS estoque_baixo
        FROM produtos p
        ORDER BY id DESC
      `);

      res.json(produtos);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/produtos",
  auth,
  async (req, res) => {
    try {
      const {
        nome,
        categoria,
        sku,
        quantidade,
        estoque_minimo,
        preco_padrao
      } = req.body;

      if (
        !nome ||
        Number(quantidade) < 0 ||
        Number(estoque_minimo) < 0 ||
        Number(preco_padrao || 0) < 0
      ) {
        return bad(
          res,
          "Dados inválidos."
        );
      }

      const id = await tx(
        async () => {
          const produto = await run(
            `
            INSERT INTO produtos
            (
              nome,
              categoria,
              sku,
              quantidade,
              estoque_minimo,
              preco_padrao
            )
            VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
              nome,
              categoria ||
                "Sem categoria",
              sku || null,
              Number(quantidade),
              Number(estoque_minimo),
              Number(
                preco_padrao || 0
              )
            ]
          );

          if (
            Number(quantidade) > 0
          ) {
            await run(
              `
              INSERT INTO
              movimentacoes_estoque
              (
                produto_id,
                tipo,
                quantidade,
                saldo_anterior,
                saldo_posterior,
                motivo,
                usuario_id
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
              `,
              [
                produto.id,
                "ENTRADA",
                Number(quantidade),
                0,
                Number(quantidade),
                "Cadastro inicial",
                req.user.id
              ]
            );
          }

          await audit(
            req.user,
            "CRIAR",
            "produtos",
            produto.id,
            nome
          );

          return produto.id;
        }
      );

      const produto = await get(
        `
        SELECT *
        FROM produtos
        WHERE id = ?
        `,
        [id]
      );

      res.status(201).json(produto);
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   ENTRADA DE ESTOQUE
========================================================= */

app.post(
  "/produtos/:id/entrada",
  auth,
  async (req, res) => {
    try {
      const quantidade = Number(
        req.body.quantidade
      );

      if (
        !Number.isInteger(
          quantidade
        ) ||
        quantidade <= 0
      ) {
        return bad(
          res,
          "Quantidade inválida."
        );
      }

      await tx(async () => {
        const produto = await get(
          `
          SELECT *
          FROM produtos
          WHERE id = ?
            AND ativo = 1
          `,
          [req.params.id]
        );

        if (!produto) {
          throw new Error(
            "Produto não encontrado."
          );
        }

        await run(
          `
          UPDATE produtos
          SET quantidade =
            quantidade + ?
          WHERE id = ?
          `,
          [
            quantidade,
            produto.id
          ]
        );

        await run(
          `
          INSERT INTO
          movimentacoes_estoque
          (
            produto_id,
            tipo,
            quantidade,
            saldo_anterior,
            saldo_posterior,
            motivo,
            usuario_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?)
          `,
          [
            produto.id,
            "ENTRADA",
            quantidade,
            produto.quantidade,
            produto.quantidade +
              quantidade,
            req.body.motivo ||
              "Entrada manual",
            req.user.id
          ]
        );
      });

      const produto = await get(
        `
        SELECT *
        FROM produtos
        WHERE id = ?
        `,
        [req.params.id]
      );

      res.json(produto);
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   MOVIMENTAÇÕES DE ESTOQUE
========================================================= */

app.get(
  "/estoque/movimentacoes",
  auth,
  async (req, res) => {
    try {
      const movimentacoes =
        await all(`
          SELECT
            m.*,
            p.nome AS produto_nome,
            u.nome AS usuario_nome
          FROM movimentacoes_estoque m
          JOIN produtos p
            ON p.id = m.produto_id
          LEFT JOIN usuarios u
            ON u.id = m.usuario_id
          ORDER BY m.id DESC
        `);

      res.json(movimentacoes);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   CLIENTES
========================================================= */

app.get(
  "/clientes",
  auth,
  async (req, res) => {
    try {
      const clientes = await all(`
        SELECT *
        FROM clientes
        WHERE ativo = 1
        ORDER BY id DESC
      `);

      res.json(clientes);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/clientes",
  auth,
  async (req, res) => {
    try {
      const {
        nome,
        cidade,
        endereco,
        telefone,
        email,
        documento
      } = req.body;

      if (
        !nome ||
        !cidade ||
        !endereco
      ) {
        return bad(
          res,
          "Nome, cidade e endereço são obrigatórios."
        );
      }

      const cliente = await run(
        `
        INSERT INTO clientes
        (
          nome,
          cidade,
          endereco,
          telefone,
          email,
          documento
        )
        VALUES (?, ?, ?, ?, ?, ?)
        `,
        [
          nome,
          cidade,
          endereco,
          telefone || null,
          email || null,
          documento || null
        ]
      );

      await audit(
        req.user,
        "CRIAR",
        "clientes",
        cliente.id,
        nome
      );

      const resultado = await get(
        `
        SELECT *
        FROM clientes
        WHERE id = ?
        `,
        [cliente.id]
      );

      res.status(201).json(
        resultado
      );
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   PEDIDOS
========================================================= */

app.get(
  "/pedidos",
  auth,
  async (req, res) => {
    try {
      const pedidos = await all(`
        SELECT
          p.*,
          c.nome AS cliente_nome
        FROM pedidos p
        JOIN clientes c
          ON c.id = p.cliente_id
        ORDER BY p.id DESC
      `);

      res.json(pedidos);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.get(
  "/pedidos/:id",
  auth,
  async (req, res) => {
    try {
      const pedido = await get(
        `
        SELECT
          p.*,
          c.nome AS cliente_nome
        FROM pedidos p
        JOIN clientes c
          ON c.id = p.cliente_id
        WHERE p.id = ?
        `,
        [req.params.id]
      );

      if (!pedido) {
        return res.status(404).json({
          erro: "Pedido não encontrado."
        });
      }

      pedido.itens =
        await all(
          `
          SELECT
            i.*,
            pr.nome AS produto_nome,
            pr.sku
          FROM itens_pedido i
          JOIN produtos pr
            ON pr.id = i.produto_id
          WHERE i.pedido_id = ?
          `,
          [pedido.id]
        );

      res.json(pedido);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/pedidos",
  auth,
  async (req, res) => {
    try {
      const {
        cliente_id,
        status,
        prioridade,
        observacoes,
        itens
      } = req.body;

      if (
        !cliente_id ||
        !Array.isArray(itens) ||
        !itens.length
      ) {
        return bad(
          res,
          "Cliente e itens são obrigatórios."
        );
      }

      if (
        status &&
        !okStatuses.includes(status)
      ) {
        return bad(
          res,
          "Status inválido."
        );
      }

      const pedidoId =
        await tx(async () => {
          const cliente =
            await get(
              `
              SELECT id
              FROM clientes
              WHERE id = ?
                AND ativo = 1
              `,
              [cliente_id]
            );

          if (!cliente) {
            throw new Error(
              "Cliente não existe."
            );
          }

          let total = 0;
          const linhas = [];

          for (const item of itens) {
            const quantidade =
              Number(
                item.quantidade
              );

            const produto =
              await get(
                `
                SELECT *
                FROM produtos
                WHERE id = ?
                  AND ativo = 1
                `,
                [item.produto_id]
              );

            if (!produto) {
              throw new Error(
                "Produto não encontrado."
              );
            }

            if (
              !Number.isInteger(
                quantidade
              ) ||
              quantidade <= 0
            ) {
              throw new Error(
                "Quantidade inválida."
              );
            }

            if (
              produto.quantidade <
              quantidade
            ) {
              throw new Error(
                `Estoque insuficiente para ${produto.nome}. Disponível: ${produto.quantidade}.`
              );
            }

            const preco =
              item.preco_unitario === "" ||
              item.preco_unitario == null
                ? produto.preco_padrao
                : Number(
                    item.preco_unitario
                  );

            if (
              preco < 0 ||
              !Number.isFinite(preco)
            ) {
              throw new Error(
                "Preço inválido."
              );
            }

            const subtotal =
              quantidade * preco;

            total += subtotal;

            linhas.push({
              produto,
              quantidade,
              preco,
              subtotal
            });
          }

          const pedido = await run(
            `
            INSERT INTO pedidos
            (
              cliente_id,
              usuario_id,
              status,
              prioridade,
              observacoes,
              valor_total
            )
            VALUES (?, ?, ?, ?, ?, ?)
            `,
            [
              cliente_id,
              req.user.id,
              status ||
                "Pendente",
              prioridade ||
                "Normal",
              observacoes || null,
              total
            ]
          );

          for (
            const linha of linhas
          ) {
            await run(
              `
              INSERT INTO itens_pedido
              (
                pedido_id,
                produto_id,
                quantidade,
                preco_unitario,
                subtotal
              )
              VALUES (?, ?, ?, ?, ?)
              `,
              [
                pedido.id,
                linha.produto.id,
                linha.quantidade,
                linha.preco,
                linha.subtotal
              ]
            );

            await run(
              `
              UPDATE produtos
              SET quantidade =
                quantidade - ?
              WHERE id = ?
              `,
              [
                linha.quantidade,
                linha.produto.id
              ]
            );

            await run(
              `
              INSERT INTO
              movimentacoes_estoque
              (
                produto_id,
                tipo,
                quantidade,
                saldo_anterior,
                saldo_posterior,
                motivo,
                pedido_id,
                usuario_id
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              `,
              [
                linha.produto.id,
                "SAIDA",
                linha.quantidade,
                linha.produto.quantidade,
                linha.produto.quantidade -
                  linha.quantidade,
                "Pedido #" +
                  pedido.id,
                pedido.id,
                req.user.id
              ]
            );
          }

          await audit(
            req.user,
            "CRIAR",
            "pedidos",
            pedido.id,
            `Total ${total}`
          );

          return pedido.id;
        });

      const pedido = await get(
        `
        SELECT *
        FROM pedidos
        WHERE id = ?
        `,
        [pedidoId]
      );

      res.status(201).json(
        pedido
      );
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   STATUS DO PEDIDO
========================================================= */

app.patch(
  "/pedidos/:id/status",
  auth,
  async (req, res) => {
    try {
      const { status } =
        req.body;

      if (
        !okStatuses.includes(status)
      ) {
        return bad(
          res,
          "Status inválido."
        );
      }

      const resultado = await run(
        `
        UPDATE pedidos
        SET
          status = ?,
          atualizado_em =
            CURRENT_TIMESTAMP
        WHERE id = ?
        `,
        [
          status,
          req.params.id
        ]
      );

      if (!resultado.changes) {
        return res.status(404).json({
          erro:
            "Pedido não encontrado."
        });
      }

      await audit(
        req.user,
        "STATUS",
        "pedidos",
        Number(req.params.id),
        status
      );

      const pedido = await get(
        `
        SELECT *
        FROM pedidos
        WHERE id = ?
        `,
        [req.params.id]
      );

      res.json(pedido);
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   MOTORISTAS
========================================================= */

app.get(
  "/motoristas",
  auth,
  async (req, res) => {
    try {
      const motoristas =
        await all(`
          SELECT *
          FROM motoristas
          WHERE ativo = 1
          ORDER BY id DESC
        `);

      res.json(motoristas);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/motoristas",
  auth,
  async (req, res) => {
    try {
      const {
        nome,
        telefone,
        cnh,
        status
      } = req.body;

      if (!nome) {
        return bad(
          res,
          "Nome obrigatório."
        );
      }

      const motorista = await run(
        `
        INSERT INTO motoristas
        (
          nome,
          telefone,
          cnh,
          status
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          nome,
          telefone || null,
          cnh || null,
          status ||
            "Disponível"
        ]
      );

      const resultado = await get(
        `
        SELECT *
        FROM motoristas
        WHERE id = ?
        `,
        [motorista.id]
      );

      res.status(201).json(
        resultado
      );
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   VEÍCULOS
========================================================= */

app.get(
  "/veiculos",
  auth,
  async (req, res) => {
    try {
      const veiculos =
        await all(`
          SELECT *
          FROM veiculos
          WHERE ativo = 1
          ORDER BY id DESC
        `);

      res.json(veiculos);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/veiculos",
  auth,
  async (req, res) => {
    try {
      const {
        placa,
        modelo,
        capacidade_kg,
        status
      } = req.body;

      if (!placa || !modelo) {
        return bad(
          res,
          "Placa e modelo obrigatórios."
        );
      }

      const veiculo = await run(
        `
        INSERT INTO veiculos
        (
          placa,
          modelo,
          capacidade_kg,
          status
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          placa.toUpperCase(),
          modelo,
          Number(
            capacidade_kg || 0
          ),
          status ||
            "Disponível"
        ]
      );

      const resultado = await get(
        `
        SELECT *
        FROM veiculos
        WHERE id = ?
        `,
        [veiculo.id]
      );

      res.status(201).json(
        resultado
      );
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   ENTREGAS
========================================================= */

app.get(
  "/entregas",
  auth,
  async (req, res) => {
    try {
      const entregas =
        await all(`
          SELECT
            e.*,
            p.valor_total,
            c.nome AS cliente_nome,
            m.nome AS motorista_nome,
            v.placa AS veiculo_placa

          FROM entregas e

          JOIN pedidos p
            ON p.id = e.pedido_id

          JOIN clientes c
            ON c.id = p.cliente_id

          LEFT JOIN motoristas m
            ON m.id = e.motorista_id

          LEFT JOIN veiculos v
            ON v.id = e.veiculo_id

          ORDER BY e.id DESC
        `);

      res.json(entregas);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/entregas",
  auth,
  async (req, res) => {
    try {
      const {
        pedido_id,
        motorista_id,
        veiculo_id,
        origem,
        destino,
        data_prevista,
        observacoes
      } = req.body;

      if (
        !pedido_id ||
        !destino
      ) {
        return bad(
          res,
          "Pedido e destino obrigatórios."
        );
      }

      const existente =
        await get(
          `
          SELECT id
          FROM entregas
          WHERE pedido_id = ?
          `,
          [pedido_id]
        );

      if (existente) {
        return bad(
          res,
          "Este pedido já possui uma entrega."
        );
      }

      const entrega = await run(
        `
        INSERT INTO entregas
        (
          pedido_id,
          motorista_id,
          veiculo_id,
          origem,
          destino,
          data_prevista,
          observacoes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          pedido_id,
          motorista_id || null,
          veiculo_id || null,
          origem || null,
          destino,
          data_prevista || null,
          observacoes || null
        ]
      );

      await audit(
        req.user,
        "CRIAR",
        "entregas",
        entrega.id
      );

      const resultado = await get(
        `
        SELECT *
        FROM entregas
        WHERE id = ?
        `,
        [entrega.id]
      );

      res.status(201).json(
        resultado
      );
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   STATUS DAS ENTREGAS
========================================================= */

app.patch(
  "/entregas/:id/status",
  auth,
  async (req, res) => {
    try {
      const { status } =
        req.body;

      const validStatuses = [
        "Aguardando",
        "Em preparação",
        "Em transporte",
        "Concluída",
        "Cancelada"
      ];

      if (
        !validStatuses.includes(
          status
        )
      ) {
        return bad(
          res,
          "Status inválido."
        );
      }

      let sql = `
        UPDATE entregas
        SET status = ?
      `;

      const params = [status];

      if (
        status ===
        "Em transporte"
      ) {
        sql +=
          ", data_saida = CURRENT_TIMESTAMP";
      }

      if (
        status ===
        "Concluída"
      ) {
        sql +=
          ", data_conclusao = CURRENT_TIMESTAMP";
      }

      sql +=
        " WHERE id = ?";

      params.push(
        req.params.id
      );

      const resultado =
        await run(
          sql,
          params
        );

      if (!resultado.changes) {
        return res.status(404).json({
          erro:
            "Entrega não encontrada."
        });
      }

      await audit(
        req.user,
        "STATUS",
        "entregas",
        Number(
          req.params.id
        ),
        status
      );

      const entrega =
        await get(
          `
          SELECT *
          FROM entregas
          WHERE id = ?
          `,
          [req.params.id]
        );

      res.json(entrega);
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   CUSTOS
========================================================= */

app.get(
  "/custos",
  auth,
  async (req, res) => {
    try {
      const custos =
        await all(`
          SELECT
            c.*,
            e.pedido_id
          FROM custos c
          LEFT JOIN entregas e
            ON e.id = c.entrega_id
          ORDER BY c.id DESC
        `);

      res.json(custos);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/custos",
  auth,
  async (req, res) => {
    try {
      const {
        entrega_id,
        tipo,
        descricao,
        valor
      } = req.body;

      if (
        !tipo ||
        Number(valor) < 0
      ) {
        return bad(
          res,
          "Tipo e valor inválidos."
        );
      }

      const custo = await run(
        `
        INSERT INTO custos
        (
          entrega_id,
          tipo,
          descricao,
          valor
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          entrega_id || null,
          tipo,
          descricao || null,
          Number(valor)
        ]
      );

      await audit(
        req.user,
        "CRIAR",
        "custos",
        custo.id
      );

      const resultado = await get(
        `
        SELECT *
        FROM custos
        WHERE id = ?
        `,
        [custo.id]
      );

      res.status(201).json(
        resultado
      );
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   RELATÓRIO
========================================================= */

app.get(
  "/relatorios/resumo",
  auth,
  async (req, res) => {
    try {
      const pedidos =
        await all(`
          SELECT
            status,
            COUNT(*) AS quantidade,
            COALESCE(
              SUM(valor_total),
              0
            ) AS valor

          FROM pedidos

          GROUP BY status
        `);

      const estoque =
        await all(`
          SELECT
            id,
            nome,
            quantidade,
            estoque_minimo

          FROM produtos

          WHERE ativo = 1
            AND quantidade <= estoque_minimo

          ORDER BY quantidade ASC
        `);

      const custos =
        await get(`
          SELECT
            COALESCE(
              SUM(valor),
              0
            ) AS total

          FROM custos
        `);

      const ticket =
        await get(`
          SELECT
            COALESCE(
              AVG(valor_total),
              0
            ) AS medio

          FROM pedidos

          WHERE status <>
            'Cancelado'
        `);

      res.json({
        pedidos,
        estoque_baixo: estoque,
        custos_total: custos.total,
        ticket_medio: ticket.medio
      });
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   AUDITORIA
========================================================= */

app.get(
  "/auditoria",
  auth,
  admin,
  async (req, res) => {
    try {
      const registros =
        await all(`
          SELECT
            a.*,
            u.nome AS usuario_nome

          FROM auditoria a

          LEFT JOIN usuarios u
            ON u.id = a.usuario_id

          ORDER BY a.id DESC

          LIMIT 500
        `);

      res.json(registros);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   USUÁRIOS
========================================================= */

app.get(
  "/usuarios",
  auth,
  admin,
  async (req, res) => {
    try {
      const usuarios =
        await all(`
          SELECT
            id,
            nome,
            email,
            tipo,
            ativo,
            criado_em

          FROM usuarios

          ORDER BY id DESC
        `);

      res.json(usuarios);
    } catch (err) {
      res.status(500).json({
        erro: err.message
      });
    }
  }
);

app.post(
  "/usuarios",
  auth,
  admin,
  async (req, res) => {
    try {
      const {
        nome,
        email,
        senha,
        tipo
      } = req.body;

      if (
        !nome ||
        !email ||
        !senha
      ) {
        return bad(
          res,
          "Nome, e-mail e senha obrigatórios."
        );
      }

      const usuario = await run(
        `
        INSERT INTO usuarios
        (
          nome,
          email,
          senha_hash,
          tipo
        )
        VALUES (?, ?, ?, ?)
        `,
        [
          nome,
          email,
          bcrypt.hashSync(
            senha,
            10
          ),
          tipo ||
            "operador"
        ]
      );

      const resultado = await get(
        `
        SELECT
          id,
          nome,
          email,
          tipo,
          ativo
        FROM usuarios
        WHERE id = ?
        `,
        [usuario.id]
      );

      res.status(201).json(
        resultado
      );
    } catch (err) {
      res.status(400).json({
        erro: err.message
      });
    }
  }
);

/* =========================================================
   FRONTEND / FALLBACK
========================================================= */

app.get(
  "*",
  (req, res) => {
    const apiRoutes = [
      "/api",
      "/auth",
      "/dashboard",
      "/produtos",
      "/clientes",
      "/pedidos",
      "/estoque",
      "/motoristas",
      "/veiculos",
      "/entregas",
      "/custos",
      "/relatorios",
      "/auditoria",
      "/usuarios",
      "/health"
    ];

    const isApiRoute =
      apiRoutes.some(
        route =>
          req.path === route ||
          req.path.startsWith(
            route + "/"
          )
      );

    if (isApiRoute) {
      return res.status(404).json({
        erro:
          "Rota não encontrada."
      });
    }

    res.sendFile(
      path.join(
        __dirname,
        "..",
        "index.html"
      )
    );
  }
);

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
  try {
    await initDatabase();

    app.listen(
      PORT,
      () => {
        console.log(
          `LogiControl V8 rodando na porta ${PORT}`
        );
      }
    );
  } catch (err) {
    console.error(
      "Falha ao inicializar banco:",
      err
    );

    process.exit(1);
  }
}

startServer();
