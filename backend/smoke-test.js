
const base=process.env.BASE_URL||"http://localhost:3000";
(async()=>{
 const h={"Content-Type":"application/json"};
 const health=await fetch(base+"/health").then(r=>r.json());
 console.log("Health:",health);
 const login=await fetch(base+"/auth/login",{method:"POST",headers:h,body:JSON.stringify({email:"admin@logicontrol.local",senha:"1234"})});
 const data=await login.json(); if(!login.ok) throw Error(data.erro);
 const auth={...h,Authorization:"Bearer "+data.token};
 for(const path of ["/dashboard","/produtos","/clientes","/pedidos","/entregas","/motoristas","/veiculos","/custos","/relatorios/resumo"])
   console.log(path, (await fetch(base+path,{headers:auth})).status);
 console.log("Smoke test concluído.");
})().catch(e=>{console.error(e);process.exit(1)});
