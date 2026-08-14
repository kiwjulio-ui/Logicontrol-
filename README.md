# LogiControl V8 — evolução da V6

A V8 consolida o sistema em uma arquitetura mais robusta, mantendo o SQLite e a interface integrada.

## O que foi aprimorado do V6 para V8

### V7 — operação e controle
- SKU e preço padrão de produto
- dados adicionais de cliente
- prioridade e observações em pedidos
- transações atômicas para pedidos/estoque
- movimentação com saldo anterior e posterior
- mudança de status de pedido
- status de entrega
- capacidade do veículo
- relatórios operacionais
- tratamento de erros mais consistente

### V8 — gestão e segurança
- autenticação JWT
- perfis administrador/operador
- auditoria de ações
- dashboard de saúde
- relatórios de ticket médio, custos e estoque crítico
- índices SQLite
- endpoints de health check
- API REST organizada
- interface responsiva
- persistência real no SQLite
- prevenção de estoque negativo dentro de transação
- atualização de status de pedidos e entregas

## Executar

```bash
cd backend
npm install
npm start
```

Depois, em outro terminal na raiz:

```bash
npx serve .
```

Abra o endereço mostrado pelo `serve`.

## Primeiro acesso

A conta administrativa é criada na primeira inicialização usando:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Esses valores devem ser configurados nas variáveis de ambiente do serviço. **A senha não fica gravada no código nem no GitHub.**

A senha é armazenada no banco usando hash com `scrypt`.


## Banco

O arquivo `backend/logicontrol.db` é criado automaticamente no primeiro início.

## Importante antes de produção

Troque `JWT_SECRET` por uma variável de ambiente forte, use HTTPS, faça backups do SQLite e altere a senha inicial do administrador.

Exemplo:

```bash
JWT_SECRET="uma-chave-grande-e-aleatoria" npm start
```

## Fluxo principal

Cliente → Pedido → validação de estoque → baixa automática → Entrega → Motorista/Veículo → Custos → Relatórios/Dashboard.

A V8 deve ser tratada como a versão de consolidação do projeto, não como uma promessa de prontidão para internet sem configuração de produção.


# Instalação simplificada

A V8 Simplificada agora sobe **frontend + API + SQLite em um único servidor**.

## Windows

Dê duplo clique em:

`INICIAR.bat`

Ou no terminal:

```bash
INICIAR.bat
```

## macOS / Linux

```bash
chmod +x INICIAR.sh
./INICIAR.sh
```

## Manual

```bash
cd backend
npm install
npm start
```

Depois abra:

`http://localhost:3000`

### Login

- E-mail: `admin@logicontrol.local`
- Senha: `1234`

Não abra o `index.html` diretamente pelo arquivo. O Express agora entrega a interface e a API pelo mesmo endereço, eliminando o problema de origem/porta do frontend.

# LogiControl V8 Mobile — PostgreSQL

Pacote preparado para publicação online e acesso pelo Android.

## Local

```bash
cd backend
npm install
npm start
```

Abra `http://localhost:3000`.

## Produção

Configure `DATABASE_URL` com a URL do PostgreSQL e `DATABASE_SSL=true`.
O projeto inclui `render.yaml` para facilitar a configuração no Render.

## Primeiro acesso

A conta administrativa é criada na primeira inicialização usando:

- `ADMIN_EMAIL`
- `ADMIN_PASSWORD`

Esses valores devem ser configurados nas variáveis de ambiente do serviço. **A senha não fica gravada no código nem no GitHub.**

A senha é armazenada no banco usando hash com `scrypt`.

