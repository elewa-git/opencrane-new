export const wrongKeyStatusScript = `
let input = '';
for await (const chunk of process.stdin) {
  input += chunk.toString();
}
const key = JSON.parse(input);
const headers = { authorization: 'Bearer ' + key };
const response = await fetch('http://model-qualification:43003/v1/models', { headers });
const body = await response.text();
if (body.includes(key)) {
  throw new Error('Credential disclosed by upstream');
}
console.log(JSON.stringify({ status: response.status }));`;
