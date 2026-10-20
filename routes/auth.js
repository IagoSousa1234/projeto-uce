const express = require('express')
const router = express.Router()
const pool = require('../config/database')
const googleCalendar = require('../config/googleCalendar')
const multer = require('multer')
const path = require('path')
const fs = require('fs')

// ---------- CRIA AS TABELAS QUE FALTAREM (roda ao iniciar o servidor) ----------

// Coluna que guarda o id do evento no Google Agenda (erro 1060 = coluna já existe)
pool.query("ALTER TABLE agendamento ADD COLUMN google_event_id VARCHAR(100) NULL", function(erro){
    if(erro && erro.errno !== 1060){
        console.log("ERRO ao criar coluna google_event_id:", erro.message)
    }
})

// Cria a agenda do Google (se precisar) e compartilha com todos os admins atuais
if(googleCalendar.ativo){
    googleCalendar.garantirCalendario().then(function(idAgenda){
        console.log("Google Agenda pronto. Agenda:", idAgenda)
        pool.query("SELECT email FROM admins_emails", function(erro, admins){
            if(erro){ return console.log(erro) }
            admins.forEach(function(a){
                googleCalendar.compartilhar(a.email).catch(function(err){
                    console.log("Google Agenda: não foi possível compartilhar com", a.email, "-", err.message)
                })
            })
        })
    }).catch(function(err){
        console.log("Google Agenda: erro ao preparar a agenda -", err.message)
    })
}

// Vídeos ficam FORA da pasta public (só saem por rota que exige login)
const pastaVideos = path.join(__dirname, '..', 'uploads', 'videos')
fs.mkdirSync(pastaVideos, { recursive: true })

const extPermitidas = ['.mp4', '.webm', '.ogg']

const uploadVideo = multer({
    storage: multer.diskStorage({
        destination: pastaVideos,
        filename: function(req, file, cb){
            const ext = path.extname(file.originalname).toLowerCase()
            cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext)
        }
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB
    fileFilter: function(req, file, cb){
        const ext = path.extname(file.originalname).toLowerCase()
        if(extPermitidas.includes(ext)){
            return cb(null, true)
        }
        cb(new Error('Formato inválido. Use MP4, WebM ou OGG.'))
    }
}).single('video')

// ---------- PORTFÓLIO: configuração ----------

// Fotos e vídeos do portfólio são públicos (aparecem para todos os visitantes)
const pastaPortfolio = path.join(__dirname, '..', 'public', 'uploads', 'portfolio')
fs.mkdirSync(pastaPortfolio, { recursive: true })

const extFotos = ['.jpg', '.jpeg', '.png', '.webp', '.gif']
const extVideos = ['.mp4', '.webm', '.ogg']

const CATEGORIA = 'pre-wedding'

function tipoPorArquivo(nome){
    return extVideos.includes(path.extname(nome).toLowerCase()) ? 'video' : 'foto'
}

const uploadPortfolio = multer({
    storage: multer.diskStorage({
        destination: pastaPortfolio,
        filename: function(req, file, cb){
            const ext = path.extname(file.originalname).toLowerCase()
            cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext)
        }
    }),
    limits: { fileSize: 500 * 1024 * 1024, files: 30 }, // 500 MB cada, até 30 por vez
    fileFilter: function(req, file, cb){
        const ext = path.extname(file.originalname).toLowerCase()
        if(extFotos.includes(ext) || extVideos.includes(ext)){
            return cb(null, true)
        }
        cb(new Error('Formato inválido. Use JPG, PNG, WEBP, GIF, MP4, WebM ou OGG.'))
    }
}).array('midias', 30)

function apagarArquivos(arquivos){
    arquivos.forEach(function(a){
        fs.unlink(path.join(pastaPortfolio, path.basename(a)), function(){})
    })
}


// ---------- MIDDLEWARES ----------

function exigirLogin(req, res, next){
    if(req.session.usuario){
        return next()
    }
    res.redirect('/login?next=' + encodeURIComponent(req.originalUrl))
}

function exigirAdmin(req, res, next){
    if(req.session.usuario && req.session.usuario.admin){
        return next()
    }
    res.status(403).send('Acesso restrito a administradores.')
}


// ---------- PÁGINAS PÚBLICAS ----------

router.get("/", function(req, res){
    res.render('index')
})

router.get("/portifolio/", function(req, res){
    res.render('portifolio')
})




// Links antigos do menu (/portifolio/pre-wedding, /portifolio/casamentos...) levam para o Pré Wedding
router.get("/portifolio/:categoria/", function(req, res){
    res.redirect('/pre-weeding/')
})

// ---------- PRÉ WEDDING (público; só admin altera) ----------

router.get("/pre-weeding/", function(req, res){

    pool.query("SELECT id, titulo, criado_em FROM portfolio_albuns WHERE categoria = ? ORDER BY id DESC",
        [CATEGORIA], function(erro, albuns){

        if(erro){
            console.log(erro)
            return res.status(500).send('Erro no servidor')
        }

        const dados = { title: 'Pré Wedding', albuns: [], erro: req.query.erro }

        if(albuns.length === 0){
            return res.render('pre-weeding', dados)
        }

        const ids = albuns.map(function(a){ return a.id })

        pool.query("SELECT id, album_id, arquivo, tipo FROM portfolio_midias WHERE album_id IN (?) ORDER BY id",
            [ids], function(erro, midias){

            if(erro){
                console.log(erro)
                return res.status(500).send('Erro no servidor')
            }

            albuns.forEach(function(album){
                album.dataTexto = new Date(album.criado_em).toLocaleDateString('pt-BR')

                album.midias = midias
                    .filter(function(m){ return m.album_id === album.id })
                    .map(function(m){
                        return {
                            id: m.id,
                            url: '/uploads/portfolio/' + m.arquivo,
                            ehVideo: m.tipo === 'video'
                        }
                    })

                // imagem principal = primeira foto (ou o primeiro vídeo, se não houver foto)
                album.principal = album.midias.find(function(m){ return !m.ehVideo }) || album.midias[0]
                album.galeria = album.midias.filter(function(m){ return m !== album.principal })
            })

            dados.albuns = albuns
            res.render('pre-weeding', dados)
        })
    })
})

// Admin adiciona um ensaio (título + várias fotos/vídeos)
router.post("/pre-weeding/adicionar", exigirAdmin, function(req, res){

    const voltar = '/pre-weeding/'

    uploadPortfolio(req, res, function(err){

        if(err){
            let msg = err.message
            if(err.code === 'LIMIT_FILE_SIZE'){ msg = 'Arquivo muito grande (máximo 500 MB cada).' }
            if(err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'){ msg = 'Muitos arquivos (máximo 30 por vez).' }
            return res.redirect(voltar + '?erro=' + encodeURIComponent(msg))
        }

        const arquivos = (req.files || []).map(function(f){ return f.filename })
        const titulo = (req.body.titulo || '').trim().slice(0, 150)

        if(!titulo || arquivos.length === 0){
            apagarArquivos(arquivos)
            return res.redirect(voltar + '?erro=' + encodeURIComponent('Informe o título e escolha ao menos uma foto ou vídeo.'))
        }

        pool.query("INSERT INTO portfolio_albuns(categoria, titulo) VALUES (?,?)", [CATEGORIA, titulo], function(erro, resultado){

            if(erro){
                console.log(erro)
                apagarArquivos(arquivos)
                return res.redirect(voltar + '?erro=' + encodeURIComponent('Erro ao salvar.'))
            }

            const albumId = resultado.insertId
            const linhas = arquivos.map(function(a){ return [albumId, a, tipoPorArquivo(a)] })

            pool.query("INSERT INTO portfolio_midias(album_id, arquivo, tipo) VALUES ?", [linhas], function(erro){

                if(erro){
                    console.log(erro)
                    apagarArquivos(arquivos)
                    // só redireciona depois de apagar o ensaio, para ele não aparecer vazio
                    return pool.query("DELETE FROM portfolio_albuns WHERE id = ?", [albumId], function(){
                        res.redirect(voltar + '?erro=' + encodeURIComponent('Erro ao salvar as mídias.'))
                    })
                }

                res.redirect(voltar)
            })
        })
    })
})

// Admin remove um ensaio inteiro (apaga também os arquivos)
router.post("/pre-weeding/albuns/:id/remover", exigirAdmin, function(req, res){

    const id = req.params.id

    pool.query("SELECT arquivo FROM portfolio_midias WHERE album_id = ?", [id], function(erro, midias){
        if(erro){
            console.log(erro)
            return res.redirect('/pre-weeding/')
        }

        pool.query("DELETE FROM portfolio_midias WHERE album_id = ?", [id], function(erro){
            if(erro){
                console.log(erro)
                return res.redirect('/pre-weeding/')
            }

            pool.query("DELETE FROM portfolio_albuns WHERE id = ? AND categoria = ?", [id, CATEGORIA], function(erro){
                if(erro){
                    console.log(erro)
                }
                apagarArquivos(midias.map(function(m){ return m.arquivo }))
                res.redirect('/pre-weeding/')
            })
        })
    })
})

// Admin remove uma foto/vídeo específico
router.post("/pre-weeding/midias/:id/remover", exigirAdmin, function(req, res){

    const id = req.params.id

    pool.query("SELECT arquivo FROM portfolio_midias WHERE id = ?", [id], function(erro, resposta){
        if(erro || resposta.length === 0){
            return res.redirect('/pre-weeding/')
        }

        pool.query("DELETE FROM portfolio_midias WHERE id = ?", [id], function(erro){
            if(erro){
                console.log(erro)
            } else {
                apagarArquivos([resposta[0].arquivo])
            }
            res.redirect('/pre-weeding/')
        })
    })
})


// ---------- CADASTRO ----------

router.get("/cadastro/", function(req, res){
    res.render('cadastro')
})

router.post("/cadastro/", function(req, res){

    const email = (req.body.email || '').trim().toLowerCase()
    const senha = req.body.senha
    const confirmar = req.body.confirmar
    const telefone = req.body.telefone

    const valores = { email: email, telefone: telefone }

    if(senha !== confirmar){
        return res.render('cadastro', { erro: 'As senhas não conferem.', valores })
    }

    pool.query("SELECT id FROM usuarios WHERE email = ?", [email], function(erro, resposta){
        if(erro){
            console.log(erro)
            return res.render('cadastro', { erro: 'Erro no servidor.', valores })
        }

        if(resposta.length > 0){
            return res.render('cadastro', { erro: 'Este e-mail já está cadastrado.', valores })
        }

        const sql = "INSERT INTO usuarios(email, senha, telefone) VALUES (?,?,?)"

        pool.query(sql, [email, senha, telefone], function(erro){
            if(erro){
                console.log(erro)
                return res.render('cadastro', { erro: 'Erro ao cadastrar.', valores })
            }
            console.log("Usuário cadastrado")
            res.redirect('/login')
        })
    })
})


// ---------- LOGIN / LOGOUT ----------

router.get("/login/", function(req, res){
    res.render('login', { next: req.query.next })
})

router.post("/login/", function(req, res){

    const email = (req.body.email || '').trim().toLowerCase()
    const senha = req.body.senha
    const next = req.body.next

    // eh_admin = 1 se o e-mail estiver na tabela admins_emails
    const sql = `
        SELECT u.id, u.email,
               (SELECT COUNT(*) FROM admins_emails a WHERE a.email = u.email) AS eh_admin
        FROM usuarios u
        WHERE u.email = ? AND u.senha = ?`

    pool.query(sql, [email, senha], function(erro, resposta){
        if(erro){
            console.log(erro)
            return res.render('login', { erro: 'Erro no servidor.', valores: { email }, next })
        }

        if(resposta.length === 0){
            return res.render('login', { erro: 'E-mail ou senha incorretos.', valores: { email }, next })
        }

        const u = resposta[0]

        req.session.usuario = {
            id: u.id,
            email: u.email,
            admin: u.eh_admin > 0
        }

        // só aceita redirecionar para caminhos internos do site
        if(next && next.startsWith('/') && !next.startsWith('//')){
            return res.redirect(next)
        }
        res.redirect('/')
    })
})

router.post("/logout/", function(req, res){
    req.session.destroy(function(){
        res.redirect('/')
    })
})


// ---------- AGENDAMENTO (precisa estar logado) ----------

router.get('/agendamento/', exigirLogin, function(req, res){

    const usuario = req.session.usuario

    // admin vê todos; usuário comum vê só os dele
    let sql = 'SELECT * FROM agendamento ORDER BY id_agendamento DESC'
    let params = []

    if(!usuario.admin){
        sql = 'SELECT * FROM agendamento WHERE usuario_id = ? ORDER BY id_agendamento DESC'
        params = [usuario.id]
    }

    pool.query(sql, params, function(erro, resposta){

        if(erro){
            console.log(erro)
            return res.status(500).send('Erro no servidor')
        }

        resposta.forEach(function(agendamento){
            if(agendamento.data_agendamento){
                agendamento.data_agendamento =
                    new Date(agendamento.data_agendamento).toLocaleDateString('pt-BR') // FORMATANDO A DATA
            } else {
                agendamento.data_agendamento = 'Data não cadastrada'
            }

            // textos/flags para a view
            agendamento.ehPendente = agendamento.status === 'pendente'
            agendamento.statusTexto = {
                pendente: 'Pendente',
                aceito: 'Aceito',
                recusado: 'Recusado'
            }[agendamento.status] || agendamento.status
        })

        res.render('agendamento', { agendamento: resposta, aviso: req.query.aviso })
    })

})

router.post("/agendamento/confirmar", exigirLogin, function(req, res){

    const nome = req.body.nome;
    const servico = req.body.servico
    const data = req.body.data;
    const horario = req.body.horario;
    const usuarioId = req.session.usuario.id;

    const sql = "INSERT INTO agendamento(nome_cliente,servico,data_agendamento,horario_agendamento,status,usuario_id) VALUES (?,?,?,?,'pendente',?)"

    pool.query(sql,[nome,servico,data,horario,usuarioId], erro=>{

    if(erro){
        console.log(erro);
        return res.status(500).send('Erro ao agendar');
    }

    console.log("Inserção Realizada")
    res.redirect('/agendamento')

    })

})

// Admin aceita ou recusa um agendamento (só quando ainda está pendente)
router.post("/agendamento/:id/status", exigirAdmin, function(req, res){

    const id = req.params.id
    const status = req.body.status

    if(status !== 'aceito' && status !== 'recusado'){
        return res.status(400).send('Status inválido.')
    }

    pool.query("UPDATE agendamento SET status = ? WHERE id_agendamento = ? AND status = 'pendente'", [status, id], function(erro, resultado){
        if(erro){
            console.log(erro)
            return res.status(500).send('Erro no servidor')
        }

        // só agendamentos ACEITOS vão para o Google Agenda
        if(status !== 'aceito' || resultado.affectedRows === 0 || !googleCalendar.ativo){
            return res.redirect('/agendamento')
        }

        pool.query("SELECT * FROM agendamento WHERE id_agendamento = ?", [id], function(erro, linhas){
            if(erro || linhas.length === 0){
                return res.redirect('/agendamento')
            }

            googleCalendar.criarEvento(linhas[0]).then(function(eventId){
                pool.query("UPDATE agendamento SET google_event_id = ? WHERE id_agendamento = ?", [eventId, id], function(){
                    res.redirect('/agendamento')
                })
            }).catch(function(err){
                console.log("Erro no Google Agenda:", err.message)
                res.redirect('/agendamento?aviso=' + encodeURIComponent('Agendamento aceito, mas não foi possível salvá-lo no Google Agenda.'))
            })
        })
    })

})


// ---------- CURSO (precisa estar logado) ----------

router.get("/curso/", exigirLogin, function(req, res){

    pool.query("SELECT id, titulo, descricao FROM aulas ORDER BY id", function(erro, aulas){
        if(erro){
            console.log(erro)
            return res.status(500).send('Erro no servidor')
        }

        aulas.forEach(function(aula, i){
            aula.numero = i + 1
        })

        res.render('curso', { aulas: aulas, erro: req.query.erro })
    })
})

// Entrega o vídeo (só para quem está logado)
router.get("/curso/video/:id", exigirLogin, function(req, res){

    pool.query("SELECT arquivo FROM aulas WHERE id = ?", [req.params.id], function(erro, resposta){
        if(erro || resposta.length === 0){
            return res.status(404).send('Vídeo não encontrado.')
        }

        const arquivo = path.basename(resposta[0].arquivo)
        res.sendFile(arquivo, { root: pastaVideos }, function(err){
            if(err && !res.headersSent){
                res.status(404).send('Vídeo não encontrado.')
            }
        })
    })
})

// Admin adiciona aula (título + descrição + vídeo)
router.post("/curso/aulas/adicionar", exigirAdmin, function(req, res){

    uploadVideo(req, res, function(err){

        if(err){
            const msg = err.code === 'LIMIT_FILE_SIZE'
                ? 'Vídeo muito grande (máximo 500 MB).'
                : err.message
            return res.redirect('/curso?erro=' + encodeURIComponent(msg))
        }

        const titulo = (req.body.titulo || '').trim().slice(0, 150)
        const descricao = (req.body.descricao || '').trim()

        if(!titulo || !req.file){
            if(req.file){ fs.unlink(req.file.path, function(){}) }
            return res.redirect('/curso?erro=' + encodeURIComponent('Informe o título e escolha um vídeo.'))
        }

        pool.query("INSERT INTO aulas(titulo, descricao, arquivo) VALUES (?,?,?)",
            [titulo, descricao, req.file.filename], function(erro){

            if(erro){
                console.log(erro)
                fs.unlink(req.file.path, function(){})
                return res.redirect('/curso?erro=' + encodeURIComponent('Erro ao salvar a aula.'))
            }
            res.redirect('/curso')
        })
    })
})

// Admin remove aula (apaga também o arquivo de vídeo)
router.post("/curso/aulas/:id/remover", exigirAdmin, function(req, res){

    const id = req.params.id

    pool.query("SELECT arquivo FROM aulas WHERE id = ?", [id], function(erro, resposta){
        if(erro){
            console.log(erro)
            return res.redirect('/curso')
        }

        pool.query("DELETE FROM aulas WHERE id = ?", [id], function(erro){
            if(erro){
                console.log(erro)
                return res.redirect('/curso')
            }

            if(resposta.length > 0){
                fs.unlink(path.join(pastaVideos, path.basename(resposta[0].arquivo)), function(){})
            }
            res.redirect('/curso')
        })
    })
})


// ---------- ÁREA ADMIN: gerenciar e-mails de admins ----------

function renderAdmin(res, extra){
    pool.query("SELECT email FROM admins_emails ORDER BY email", function(erro, resposta){
        if(erro){
            console.log(erro)
            return res.status(500).send('Erro no servidor.')
        }
        res.render('admin', Object.assign({ admins: resposta, linkAgenda: googleCalendar.linkAgenda() }, extra))
    })
}

router.get("/admin/", exigirAdmin, function(req, res){
    renderAdmin(res, {})
})

router.post("/admin/adicionar", exigirAdmin, function(req, res){
    const email = (req.body.email || '').trim().toLowerCase()

    pool.query("INSERT IGNORE INTO admins_emails(email) VALUES (?)", [email], function(erro){
        if(erro){
            console.log(erro)
        } else if(googleCalendar.ativo){
            googleCalendar.compartilhar(email).catch(function(err){
                console.log("Google Agenda: não foi possível compartilhar com", email, "-", err.message)
            })
        }
        res.redirect('/admin')
    })
})

router.post("/admin/remover", exigirAdmin, function(req, res){
    const email = (req.body.email || '').trim().toLowerCase()

    // impede que você remova a si mesmo e fique sem admin
    if(email === req.session.usuario.email){
        return renderAdmin(res, { erro: 'Você não pode remover o seu próprio e-mail.' })
    }

    pool.query("DELETE FROM admins_emails WHERE email = ?", [email], function(erro){
        if(erro){
            console.log(erro)
        } else if(googleCalendar.ativo){
            googleCalendar.descompartilhar(email).catch(function(err){
                console.log("Google Agenda: não foi possível remover o acesso de", email, "-", err.message)
            })
        }
        res.redirect('/admin')
    })
})


module.exports = router