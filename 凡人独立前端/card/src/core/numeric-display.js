// Display only. Decimal-string shifting preserves digits; never write this text into state.
export function formatDisplayNumber(value) {
  if (typeof value !== 'number' && typeof value !== 'string' && typeof value !== 'bigint') return String(value ?? '');
  if (typeof value === 'number' && !Number.isFinite(value)) return String(value);
  const raw=String(value), text=raw.trim().replace(/^−/,'-');
  const match=text.match(/^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/);
  if (!match) return raw;
  const sign=match[1], whole=match[2]||'0', fraction=match[3]??match[4]??'';
  const exponent=Number(match[5]||0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent)>1000) return raw;
  let digits=whole+fraction, point=whole.length+exponent;
  const leading=digits.match(/^0*/)[0].length; digits=digits.slice(leading); point-=leading;
  if (!digits || point<=4) return raw;
  point-=4;
  let result=point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point);
  result=result.replace(/(\.\d*?)0+$/,'$1').replace(/\.$/,'');
  return (raw.trim().startsWith('−')?'−':sign)+result+'万';
}
export function formatDisplayNumericText(value) {
  const text=String(value??'');
  const ratio=text.match(/^\s*([^/]+)\s*\/\s*([^/]+)\s*$/);
  const numeric=/^[+−-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  if (ratio && ratio.slice(1).every(x=>numeric.test(x.trim()))) return ratio.slice(1).map(x=>formatDisplayNumber(x.trim())).join(' / ');
  if (text.endsWith('%')&&numeric.test(text.slice(0,-1).trim())) return formatDisplayNumber(text.slice(0,-1).trim())+'%';
  return formatDisplayNumber(value);
}
