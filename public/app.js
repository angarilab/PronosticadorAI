const $ = selector => document.querySelector(selector);
const state = { user: null, forecasts: [], league: 'Todas', access: 'all', demo: true };
const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const pct = value => `${(value * 100).toFixed(1).replace('.', ',')} %`;
const date = value => new Intl.DateTimeFormat('es', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud.');
  return data;
}
function showModal(content) {
  $('#modal-content').innerHTML = content;
  if (!$('#modal').open) $('#modal').showModal();
}
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; setTimeout(() => { $('#toast').hidden = true; }, 5000); }
function renderAccount() {
  $('#account').innerHTML = state.user ? `<div class="user-chip"><span>${escape(state.user.email.split('@')[0])}</span><span class="badge ${state.user.plan}">${state.user.plan === 'premium' ? 'Premium' : 'Gratis'}</span><button id="logout" class="nav-link">Salir</button></div>` : '<button class="button small outline" id="login">Iniciar sesión <span>↗</span></button>';
  $('#login')?.addEventListener('click', () => auth('login'));
  $('#logout')?.addEventListener('click', async () => { try { await api('/api/logout', { method: 'POST', body: '{}' }); state.user = null; await refresh(); toast('Has cerrado la sesión.'); } catch (error) { toast(error.message); } });
}
function renderCards() {
  const items = state.forecasts.filter(item => (state.league === 'Todas' || state.league === item.league) && (state.access === 'all' || state.access === item.access));
  $('#result-count').textContent = `${items.length} ${state.demo ? 'escenarios' : 'partidos'}`;
  $('#cards').innerHTML = items.length ? items.map((item, index) => {
    const p = item.probabilities;
    const best = p ? ['home', 'draw', 'away'].sort((a, b) => p[b] - p[a])[0] : null;
    return `<article class="forecast-card ${item.locked ? 'locked' : ''}"><div class="card-top"><span>${escape(item.league)} <span class="muted">/ ${item.demo ? 'ESCENARIO' : 'PARTIDO'}</span></span><span class="badge ${item.access}">${item.access === 'free' ? 'Gratis' : 'Premium'}</span></div><div class="teams"><div class="team"><div class="crest crest-home">${escape(item.home.slice(0, 1))}</div><h3>${escape(item.home)}</h3></div><span class="versus">VS</span><div class="team"><div class="crest crest-away">${escape(item.away.slice(0, 1))}</div><h3>${escape(item.away)}</h3></div></div><p class="synthetic-note">${item.demo ? 'Ejemplo hipotético · No hay partido programado' : escape(date(item.kickoff)) + ' · Hora local'}</p>${item.locked ? '<div class="locked-content"><span class="lock-icon">◇</span><strong>Una mirada más profunda</strong><p>Análisis reservado a suscriptores.</p></div>' : `<div class="probability-row"><div class="${best === 'home' ? 'favored' : ''}"><span>LOCAL</span><strong>${pct(p.home)}</strong></div><div class="${best === 'draw' ? 'favored' : ''}"><span>EMPATE</span><strong>${pct(p.draw)}</strong></div><div class="${best === 'away' ? 'favored' : ''}"><span>VISITANTE</span><strong>${pct(p.away)}</strong></div></div><div class="card-insight"><span class="accent">↗</span><span>Goles esperados: <strong>${item.homeGoals.toFixed(2)} / ${item.awayGoals.toFixed(2)}</strong></span></div>`}<button class="card-action" data-id="${escape(item.id)}">${item.locked ? 'Conocer el acceso premium' : 'Ver análisis matemático'} <span>↗</span></button></article>`;
  }).join('') : `<div class="empty">${state.demo ? 'No hay escenarios para esta combinación. Prueba otra liga o tipo de acceso.' : 'No hay partidos futuros con datos suficientes para estos filtros. Los pronósticos no se sustituyen por ejemplos ficticios.'}</div>`;
  document.querySelectorAll('[data-id]').forEach(button => button.addEventListener('click', () => openForecast(button.dataset.id)));
}
async function refresh() {
  const response = await api('/api/forecasts');
  state.forecasts = response.forecasts; state.demo = response.demo;
  const provider = response.dataset.provider || 'football-data.org';
  $('#dataset-label').textContent = state.demo ? 'DEMO' : 'DATOS API';
  $('#dataset-note').textContent = state.demo ? 'Equipos y parámetros ficticios. Estos escenarios muestran cómo funciona el modelo; no son pronósticos de partidos reales.' : `Datos de ${provider} consultados el ${date(response.dataset.syncedAt)}. Estimaciones exploratorias, sin validación histórica fuera de muestra.`;
  $('#dataset-eyebrow').textContent = state.demo ? 'EXPLORA LOS ESCENARIOS' : 'PARTIDOS DE LOS PRÓXIMOS SIETE DÍAS';
  $('#footer-status').textContent = state.demo ? 'Prototipo · Datos sintéticos · Sin pagos activos' : `Estimaciones exploratorias · ${provider} · Sin pagos activos`;
  renderAccount(); renderCards();
}
function renderAI(explanation) {
  return `<h3>Lectura del agente IA</h3><p class="fine-print">${escape(explanation.provider)} · ${escape(explanation.model)} · ${escape(date(explanation.generatedAt))}</p><p>${escape(explanation.interpretation)}</p><h3>Supuestos</h3><p>${escape(explanation.assumptions)}</p><h3>Limitaciones</h3><p>${escape(explanation.cautions)}</p><p class="fine-print">${escape(explanation.note)}</p>`;
}
async function openForecast(id) {
  if (state.forecasts.find(item => item.id === id)?.locked) return plans();
  try {
    const item = await api(`/api/forecasts/${encodeURIComponent(id)}`);
    const p = item.probabilities;
    showModal(`<p class="eyebrow">${escape(item.league)} · ${item.demo ? 'ESCENARIO HIPOTÉTICO' : 'ESTIMACIÓN EXPLORATORIA'}</p><h2>${escape(item.home)}<br><span class="muted">vs.</span> ${escape(item.away)}</h2><span class="badge free">${escape(item.method)}</span><p class="analysis-text">${escape(item.explanation)}</p><section class="ai-section" id="ai-section">${item.aiExplanation ? renderAI(item.aiExplanation) : `<h3>Lectura del agente IA</h3><p class="fine-print">${item.aiAvailable ? "Una explicación en español basada en los datos y supuestos de este modelo." : "La explicación IA aún no está disponible. Puedes consultar el análisis matemático completo."}</p>${item.aiAvailable ? '<button class="button outline" id="request-ai">Pedir explicación IA ↗</button>' : ""}<p id="ai-error" role="alert" class="form-error"></p>`}</section><div class="detail-markets"><div><span>Más de 2,5 goles</span><strong>${pct(p.over25)}</strong></div><div><span>Ambos marcan</span><strong>${pct(p.bothScore)}</strong></div></div><h3>Marcadores más probables</h3><div class="score-list">${item.scores.map(score => `<div><span>${score.home} – ${score.away}</span><progress max="1" value="${score.probability}" aria-label="Probabilidad de ${score.home} a ${score.away}"></progress><strong>${pct(score.probability)}</strong></div>`).join('')}</div><p class="fine-print">Estos cinco marcadores son una selección; no cubren todos los resultados.</p><div class="method-note"><h3>Origen y supuestos</h3><p>${escape(item.source)}</p><p>${escape(item.limitations)}</p><p>${escape(item.analysisType)}</p><p>Masa omitida al truncar: ${(item.omittedMass * 100).toExponential(2)} %. Distribución renormalizada.</p></div>`);
    $('#request-ai')?.addEventListener('click', async event => {
      if (!state.user) return auth('login');
      const button = event.currentTarget; button.disabled = true; button.textContent = 'Preparando explicación…';
      try {
        const response = await api(`/api/forecasts/${encodeURIComponent(id)}/explanation`, { method: 'POST', body: '{}' });
        if ($('#modal').open && $('#ai-section') && button.isConnected) $('#ai-section').innerHTML = renderAI(response.explanation);
      } catch (error) {
        if (button.isConnected) { $('#ai-error').textContent = error.message; button.disabled = false; button.textContent = 'Reintentar explicación IA'; }
      }
    });
  } catch (error) { toast(error.message); }
}
function auth(mode) {
  const register = mode === 'register';
  showModal(`<p class="eyebrow">TU ESPACIO DE ANÁLISIS</p><h2>${register ? 'Crea tu cuenta.' : 'Bienvenido de nuevo.'}</h2><p class="muted">${register ? 'Empieza con el acceso gratuito.' : 'Accede a tu cuenta de PronosticadorAI.'}</p><form id="auth-form"><label>Email<input name="email" type="email" autocomplete="email" required maxlength="254" placeholder="tu@email.com"></label><label>Contraseña<input name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" required minlength="10" maxlength="128" placeholder="Al menos 10 caracteres"></label><p class="form-error" role="alert" id="form-error"></p><button class="button primary" type="submit">${register ? 'Crear cuenta gratis' : 'Iniciar sesión'} <span>↗</span></button></form><p class="auth-switch">${register ? '¿Ya tienes cuenta?' : '¿Primera vez aquí?'} <button class="text-button" id="switch-auth">${register ? 'Inicia sesión' : 'Crea tu cuenta'}</button></p>`);
  $('#switch-auth').addEventListener('click', () => auth(register ? 'login' : 'register'));
  $('#auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.target.querySelector('button[type="submit"]'); button.disabled = true;
    $('#form-error').textContent = '';
    try {
      const input = Object.fromEntries(new FormData(event.target));
      state.user = (await api(register ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(input) })).user;
      await refresh(); $('#modal').close(); toast(register ? 'Tu cuenta gratuita está lista.' : 'Sesión iniciada.');
    } catch (error) { $('#form-error').textContent = error.message; } finally { button.disabled = false; }
  });
}
function plans() {
  showModal(`<p class="eyebrow">ACCESO A LOS ANÁLISIS</p><h2>Encuentra tu perspectiva.</h2><div class="plan-grid"><section class="plan"><span class="badge free">Gratis</span><h3>Explora</h3><p class="plan-price">0 €</p><ul><li>Escenarios abiertos</li><li>Probabilidades y método</li><li>Cuenta personal</li></ul><button class="button outline" id="free-plan">${state.user ? 'Volver a los análisis' : 'Crear cuenta gratis'}</button></section><section class="plan premium-plan"><span class="badge premium">Premium</span><h3>Profundiza</h3><p class="plan-price">Próximamente</p><ul><li>Acceso a todos los análisis</li><li>Precio pendiente de definir</li><li>Sin cobros en esta demo</li></ul><p class="fine-print">La contratación se habilitará al integrar el proveedor de pagos. ${state.user?.plan === 'premium' ? 'Tu cuenta tiene acceso premium.' : 'El registro gratuito no activa premium.'}</p></section></div>`);
  $('#free-plan').addEventListener('click', () => state.user ? $('#modal').close() : auth('register'));
}
$('#close-modal').addEventListener('click', () => $('#modal').close());
$('#modal').addEventListener('click', event => { if (event.target === $('#modal')) { const r = $('#modal').getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) $('#modal').close(); } });
$('#plans-nav').addEventListener('click', plans); $('#plans-bottom').addEventListener('click', plans);
$('#league-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-league]'); if (!button) return;
  state.league = button.dataset.league;
  document.querySelectorAll('[data-league]').forEach(tab => { const active = tab === button; tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active)); });
  renderCards();
});
$('#access-filter').addEventListener('change', event => { state.access = event.target.value; renderCards(); });
(async () => { try { state.user = (await api('/api/me')).user; await refresh(); } catch { $('#cards').innerHTML = '<p role="alert">No se pudieron cargar los escenarios. Recarga la página para reintentar.</p>'; } })();
