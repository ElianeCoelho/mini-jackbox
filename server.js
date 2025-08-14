// server.js
// Servidor mínimo com Express + Socket.IO.
// Responsável por: criar salas, gerenciar jogadores, rodadas e placar.

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Servir arquivos estáticos da pasta /public
app.use(express.static("public"));

// ---------- ESTADO EM MEMÓRIA (simples para protótipo) ----------
/*
  Estrutura:
  salas = {
    "ABCD": {
      hostId: "<socket-id-do-host>",
      jogadores: { "<socket-id>": { nome: "Ana", pontos: 0 } },
      fase: "lobby" | "pergunta" | "resultado",
      perguntaAtual: {
        enunciado: "2 + 2 = ?",
        alternativas: ["3", "4", "5", "22"],
        correta: 1 // índice da alternativa correta
      },
      respostasRecebidas: { "<socket-id>": 1 } // índice escolhido
    }
  }
*/
const salas = {};

// Utilitário: gera um código curto de sala (4 letras)
function gerarCodigoSala() {
  const letras = "ABCDEFGHJKMNPQRSTUVWXYZ"; // sem I/O para evitar confusão
  let codigo = "";
  for (let i = 0; i < 4; i++) {
    codigo += letras[Math.floor(Math.random() * letras.length)];
  }
  return salas[codigo] ? gerarCodigoSala() : codigo;
}

// Pergunta de exemplo (MVP)
function obterPerguntaExemplo() {
  return {
    enunciado: "Quanto é 2 + 2?",
    alternativas: ["3", "4", "5", "22"],
    correta: 1
  };
}

// ---------- SOCKET.IO ----------
io.on("connection", (socket) => {
  // Console para debug básico
  console.log("Conectado:", socket.id);

  // HOST cria uma sala
  socket.on("criarSala", () => {
    const codigo = gerarCodigoSala();
    salas[codigo] = {
      hostId: socket.id,
      jogadores: {},
      fase: "lobby",
      perguntaAtual: null,
      respostasRecebidas: {}
    };
    socket.join(codigo);
    socket.emit("salaCriada", { codigo });
    console.log(`Sala ${codigo} criada por ${socket.id}`);
  });

  // JOGADOR tenta entrar na sala
  socket.on("entrarSala", ({ codigo, nome }) => {
    const sala = salas[codigo];
    if (!sala) {
      socket.emit("erro", { mensagem: "Sala não encontrada." });
      return;
    }
    if (sala.fase !== "lobby") {
      socket.emit("erro", { mensagem: "Jogo já iniciou. Aguarde a próxima." });
      return;
    }
    sala.jogadores[socket.id] = { nome: String(nome || "Jogador"), pontos: 0 };
    socket.join(codigo);

    // Confirma ao jogador e atualiza o lobby para todos
    socket.emit("entrouNaSala", { codigo, nome: sala.jogadores[socket.id].nome });
    io.to(codigo).emit("estadoLobby", {
      jogadores: Object.values(sala.jogadores).map((j) => j.nome)
    });
  });

  // HOST inicia a rodada
  socket.on("iniciarRodada", ({ codigo }) => {
    const sala = salas[codigo];
    if (!sala || sala.hostId !== socket.id) return;

    sala.fase = "pergunta";
    sala.perguntaAtual = obterPerguntaExemplo();
    sala.respostasRecebidas = {};

    // Envia a pergunta para todos da sala (host e jogadores)
    io.to(codigo).emit("novaPergunta", {
      enunciado: sala.perguntaAtual.enunciado,
      alternativas: sala.perguntaAtual.alternativas,
      tempo: 15 // segundos
    });

    // Cronômetro no servidor (o servidor define o fim da rodada)
    setTimeout(() => {
      finalizarRodada(codigo);
    }, 15000);
  });

  // JOGADOR envia resposta
  socket.on("responder", ({ codigo, indice }) => {
    const sala = salas[codigo];
    if (!sala || sala.fase !== "pergunta") return;
    if (!sala.jogadores[socket.id]) return;

    // Valida índice
    const i = Number(indice);
    if (Number.isNaN(i)) return;

    // Salva primeira resposta do jogador (não deixa trocar)
    if (sala.respostasRecebidas[socket.id] === undefined) {
      sala.respostasRecebidas[socket.id] = i;
      // Feedback opcional só para o jogador
      socket.emit("respostaRecebida");
    }
  });

  // Desconexão: remover jogador e avisar sala
  socket.on("disconnect", () => {
    // Descobrir de quais salas este socket participava
    for (const codigo of Object.keys(salas)) {
      const sala = salas[codigo];
      if (!sala) continue;

      // Se for o HOST
      if (sala.hostId === socket.id) {
        // Encerra a sala
        io.to(codigo).emit("erro", { mensagem: "Host saiu. Sala encerrada." });
        // Expulsa todos (sala será removida)
        for (const idJog of Object.keys(sala.jogadores)) {
          io.sockets.sockets.get(idJog)?.leave(codigo);
        }
        delete salas[codigo];
        console.log(`Sala ${codigo} encerrada (host saiu).`);
        continue;
      }

      // Se for JOGADOR
      if (sala.jogadores[socket.id]) {
        const nome = sala.jogadores[socket.id].nome;
        delete sala.jogadores[socket.id];
        io.to(codigo).emit("estadoLobby", {
          jogadores: Object.values(sala.jogadores).map((j) => j.nome)
        });
        console.log(`Jogador ${nome} saiu da sala ${codigo}`);
      }
    }
  });
});

// Finaliza a rodada: calcula pontuação, envia resultado e volta ao lobby
function finalizarRodada(codigo) {
  const sala = salas[codigo];
  if (!sala || sala.fase !== "pergunta") return;

  sala.fase = "resultado";

  // Corrigir e pontuar
  const correta = sala.perguntaAtual.correta;
  for (const [id, resp] of Object.entries(sala.respostasRecebidas)) {
    if (resp === correta && sala.jogadores[id]) {
      sala.jogadores[id].pontos += 1; // +1 por acerto (MVP)
    }
  }

  // Montar placar simples
  const placar = Object.values(sala.jogadores)
    .map((j) => ({ nome: j.nome, pontos: j.pontos }))
    .sort((a, b) => b.pontos - a.pontos);

  io.to(codigo).emit("resultadoRodada", {
    correta,
    placar
  });

  // Volta para o lobby após alguns segundos
  setTimeout(() => {
    sala.fase = "lobby";
    io.to(codigo).emit("estadoLobby", {
      jogadores: Object.values(sala.jogadores).map((j) => j.nome)
    });
  }, 5000);
}


const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor em http://localhost:${PORT}`);
});
