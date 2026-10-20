// Integração com o Google Agenda usando uma CONTA DE SERVIÇO.
// O servidor cria (uma vez) uma agenda compartilhada "Agendamentos" e
// compartilha com o e-mail de cada admin. Cada agendamento ACEITO vira um evento nela.

const fs = require('fs')
const path = require('path')

const ARQUIVO_CREDENCIAIS = process.env.GOOGLE_CREDENTIALS || path.join(__dirname, 'google-credentials.json')
const ARQUIVO_ID_AGENDA = path.join(__dirname, 'google-calendar-id.txt')
const FUSO = 'America/Sao_Paulo'
const DURACAO_HORAS = 1 // duração de cada sessão no calendário

const ativo = fs.existsSync(ARQUIVO_CREDENCIAIS)

let calendar = null
let calendarId = null
let promessaAgenda = null

if(ativo){
    const { google } = require('googleapis')
    const auth = new google.auth.GoogleAuth({
        keyFile: ARQUIVO_CREDENCIAIS,
        scopes: ['https://www.googleapis.com/auth/calendar']
    })
    calendar = google.calendar({ version: 'v3', auth })

    if(fs.existsSync(ARQUIVO_ID_AGENDA)){
        calendarId = fs.readFileSync(ARQUIVO_ID_AGENDA, 'utf8').trim()
    }
} else {
    console.log('Google Agenda desativado (arquivo config/google-credentials.json não encontrado).')
}

// Garante que a agenda compartilhada existe (cria na primeira vez)
function garantirCalendario(){
    if(!ativo){ return Promise.reject(new Error('Google Agenda não configurado')) }
    if(calendarId){ return Promise.resolve(calendarId) }

    if(!promessaAgenda){
        promessaAgenda = calendar.calendars.insert({
            requestBody: { summary: 'Agendamentos - Kleber Kawasaki', timeZone: FUSO }
        }).then(function(resp){
            calendarId = resp.data.id
            fs.writeFileSync(ARQUIVO_ID_AGENDA, calendarId)
            console.log('Agenda do Google criada:', calendarId)
            return calendarId
        }).catch(function(err){
            promessaAgenda = null
            throw err
        })
    }
    return promessaAgenda
}

// Dá acesso de leitura da agenda a um e-mail (conta Google do admin)
function compartilhar(email){
    return garantirCalendario().then(function(id){
        return calendar.acl.insert({
            calendarId: id,
            requestBody: { role: 'reader', scope: { type: 'user', value: email } }
        })
    })
}

// Tira o acesso de um e-mail
function descompartilhar(email){
    return garantirCalendario().then(function(id){
        return calendar.acl.delete({ calendarId: id, ruleId: 'user:' + email })
    })
}

function doisDigitos(n){ return String(n).padStart(2, '0') }

// data do banco (Date ou texto) -> "AAAA-MM-DD"
function dataParaTexto(data){
    if(data instanceof Date){
        return data.getFullYear() + '-' + doisDigitos(data.getMonth() + 1) + '-' + doisDigitos(data.getDate())
    }
    return String(data).slice(0, 10)
}

// Cria o evento de um agendamento aceito e devolve o id do evento
function criarEvento(agendamento){
    return garantirCalendario().then(function(id){

        const ymd = dataParaTexto(agendamento.data_agendamento)
        const hora = String(agendamento.horario_agendamento || '00:00:00').slice(0, 5)

        const inicio = ymd + 'T' + hora + ':00'

        // fim = início + duração (conta como "hora de parede", o fuso vai no campo timeZone)
        const p = ymd.split('-').map(Number)
        const h = hora.split(':').map(Number)
        const fim = new Date(Date.UTC(p[0], p[1] - 1, p[2], h[0], h[1]))
        fim.setUTCHours(fim.getUTCHours() + DURACAO_HORAS)

        return calendar.events.insert({
            calendarId: id,
            requestBody: {
                summary: (agendamento.servico || 'Sessão de Fotos') + ' - ' + agendamento.nome_cliente,
                description: 'Cliente: ' + agendamento.nome_cliente + '\nServiço: ' + agendamento.servico,
                start: { dateTime: inicio, timeZone: FUSO },
                end: { dateTime: fim.toISOString().slice(0, 19), timeZone: FUSO }
            }
        })
    }).then(function(resp){
        return resp.data.id
    })
}

// Link para o admin adicionar a agenda compartilhada ao próprio Google Agenda
function linkAgenda(){
    if(!ativo || !calendarId){ return null }
    return 'https://calendar.google.com/calendar/render?cid=' + encodeURIComponent(calendarId)
}

module.exports = { ativo, garantirCalendario, compartilhar, descompartilhar, criarEvento, linkAgenda }
