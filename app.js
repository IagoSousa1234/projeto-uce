const express = require('express')
const session = require('express-session')
const { engine } = require('express-handlebars')
const path = require('path')
const authRoutes = require('./routes/auth')

const app = express()
const port = 3000

// Arquivos estáticos (css, img, icon, js)
app.use(express.static('public'))

// Handlebars
app.engine('handlebars', engine({
    defaultLayout: 'main',            // views/layouts/main.handlebars
    partialsDir: ['views/partials']
}))
app.set('view engine', 'handlebars')
app.set('views', path.join(__dirname, 'views'))

// Formulários e JSON
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Sessão (antes das rotas)
app.use(session({
    secret: 'sua_chave_secreta_aqui',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}))

// Dados do login disponíveis em TODAS as views (usados no main.handlebars)
app.use(function(req, res, next){
    const u = req.session.usuario
    res.locals.user = u || null
    res.locals.isAdmin = u ? u.admin : false
    res.locals.primeiroNome = u ? u.email.split('@')[0] : ''
    next()
})

// Rotas (depois da sessão)
app.use('/', authRoutes)

app.listen(port, function(erro){
    if(erro){
        console.log('Erro!')
    } else{
        console.log('Servidor iniciado')
    }
})