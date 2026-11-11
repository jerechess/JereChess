// Matchmaking policy for JereChess 2.4.2. Ratings are search hints only;
// they MUST NOT be used for official rating calculations.
export const MIN_RATING=100, MAX_RATING=4000;
export function rating(value){const n=Number(value);return Number.isInteger(n)&&n>=MIN_RATING&&n<=MAX_RATING?n:1500}
export function rangeAfter(ms){return Math.min(2000,150+Math.floor(Math.max(0,ms)/15000)*100)}
export function compatible(a,b){return a.uid!==b.uid&&a.clock===b.clock&&a.rated===b.rated&&a.status==='waiting'&&b.status==='waiting'}
export function eligible(a,b,now){return compatible(a,b)&&Math.abs(a.rating-b.rating)<=Math.max(rangeAfter(now-a.joinedAt),rangeAfter(now-b.joinedAt))}
export function chooseRival(me,players,now){return players.filter(x=>eligible(me,x,now)).sort((a,b)=>Math.abs(me.rating-a.rating)-Math.abs(me.rating-b.rating)||a.joinedAt-b.joinedAt)[0]||null}
