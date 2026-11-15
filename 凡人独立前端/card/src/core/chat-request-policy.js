// Applies to Chat Completions. Inspect the actual model ID, including proxy prefixes.
export function chatReasoningParameters(model, choice = 'auto') {
  const id = String(model || '').trim().toLowerCase();
  const gemini = /(?:^|[/:])gemini(?:[-_]|$)/.test(id);
  const deepSeekFlash = /(?:^|[/:])deepseek-(?:v4(?:\.1)?-)?flash(?:[-_@: ]|$)/.test(id);
  const deepSeekV4 = deepSeekFlash || /(?:^|[/:])deepseek-v4(?:[.\-_]|$)/.test(id);
  let effort = String(choice || 'auto').trim().toLowerCase();
  if (effort === 'provider') return {};
  if (effort === 'auto') return gemini || deepSeekFlash ? { reasoning_effort: 'high' } : {};
  if (effort === 'none' && /deepseek/i.test(id)) return { thinking: { type: 'disabled' } };
  if (effort === 'none' && /(?:^|[/:])gemini-3(?:[.\-_]|$)/.test(id)) return {};
  if (effort === 'min' && !/^gpt-5/.test(id)) effort = 'low';
  if (effort === 'max' && !deepSeekV4) effort = 'high';
  if (effort === 'medium' && deepSeekV4) effort = 'high';
  return ['none', 'min', 'low', 'medium', 'high', 'max'].includes(effort) ? { reasoning_effort: effort } : {};
}

// Conservative defaults for documented endpoints; gateways keep their chosen compatibility.
export function chatRequestBody(payload, {apiUrl, profile, effort, purpose} = {}) {
  const body = {...payload};
  let host = '';
  try { host = new URL(apiUrl).hostname; } catch (_) {}
  const id = String(body.model || '').toLowerCase().split('/').at(-1);
  const selected = profile?.reasoningEffort || effort || 'auto';
  const family = profile?.modelFamily || 'auto';
  const reasoning = chatReasoningParameters(id, selected);
  const strictOpenAI = family==='openai'||family==='auto'&&host === 'api.openai.com';
  const officialGemini = family==='gemini'||family==='auto'&&
    (host === 'generativelanguage.googleapis.com'||/^gemini(?:[-_]|$)/.test(id));
  const officialDeepSeek = family==='deepseek'||family==='auto'&&
    (host === 'api.deepseek.com'||/^deepseek-(?:v4|flash|reasoner)/.test(id));
  const openAIReasoning = /^(?:gpt-5(?:[.-]|$)|o[134](?:-|$))/.test(id);
  if (strictOpenAI && openAIReasoning && reasoning.reasoning_effort === 'min') reasoning.reasoning_effort = 'minimal';
  if (selected==='auto' && ['worldview','summary'].includes(purpose) &&
      (strictOpenAI&&openAIReasoning||officialGemini||officialDeepSeek)) reasoning.reasoning_effort='low';
  if (strictOpenAI && !openAIReasoning) delete reasoning.reasoning_effort;
  if(officialGemini&&!/^gemini-2\.5/.test(id)&&reasoning.reasoning_effort==='none')delete reasoning.reasoning_effort;
  if(officialDeepSeek&&selected==='none'){
    delete reasoning.reasoning_effort;
    reasoning.thinking={type:'disabled'};
  }
  if(officialDeepSeek&&selected!=='auto'&&selected!=='provider'&&selected!=='none')
    reasoning.reasoning_effort=selected==='medium'?'high':selected;
  if(officialGemini&&reasoning.reasoning_effort==='max')reasoning.reasoning_effort='high';
  if(strictOpenAI&&reasoning.reasoning_effort==='none'&&
      /^(?:o[134](?:-|$)|gpt-5(?:-mini|-nano|-\d{4}|$))/.test(id))delete reasoning.reasoning_effort;
  Object.assign(body, reasoning);

  if (strictOpenAI && openAIReasoning && body.max_tokens !== undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }
  if (profile?.stream===false)body.stream=false;
  if (strictOpenAI && openAIReasoning || officialGemini || officialDeepSeek) {
    for (const key of ['top_k','top_a','min_p','repetition_penalty','seed','frequency_penalty','presence_penalty']) delete body[key];
  }
  const openAISampling = /^gpt-5\.[12](?:-|$)/.test(id)&&reasoning.reasoning_effort==='none';
  if (strictOpenAI && openAIReasoning && !openAISampling || officialGemini ||
      officialDeepSeek && reasoning.thinking?.type !== 'disabled') {
    delete body.temperature;
    delete body.top_p;
  }
  if (officialDeepSeek && reasoning.thinking?.type === 'disabled')delete body.top_p;
  if (profile?.systemAsUser === true)
    body.messages = body.messages.map(row => row.role === 'system' ? {...row,role:'user'} : row);
  if (profile?.noPrefill === true && ['assistant','model'].includes(body.messages.at(-1)?.role))
    body.messages = body.messages.concat({role:'user',content:'请根据以上资料完成本次回复。'});
  if (profile?.jsonMode===true && ['json','test'].includes(purpose))body.response_format={type:'json_object'};
  return body;
}

export function chatCompletionsEndpoint(apiUrl) {
  const url = new URL(String(apiUrl).trim());
  let path = url.pathname.replace(/\/+$/, '').replace(/\/models$/i,'');
  if (!/\/chat\/completions$/i.test(path)) {
    if (!path) path=url.hostname==='generativelanguage.googleapis.com'?'/v1beta/openai':'/v1';
    else if (url.hostname==='generativelanguage.googleapis.com'&&/^\/v\d+(?:beta|alpha)?$/i.test(path)) path+='/openai';
    url.pathname=path+'/chat/completions';
  }
  return url.href;
}

export function normalizeChatRequestProfile(value) {
  const profile = {};
  if (!value || typeof value !== 'object') return profile;
  if (['provider','none','low','medium','high','max'].includes(value.reasoningEffort))
    profile.reasoningEffort = value.reasoningEffort;
  if (['openai','gemini','deepseek','compatible'].includes(value.modelFamily))
    profile.modelFamily=value.modelFamily;
  if(value.stream===false)profile.stream=false;
  for (const key of ['systemAsUser','noPrefill','jsonMode'])
    if (value[key] === true) profile[key] = true;
  return profile;
}

