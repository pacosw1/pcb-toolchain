// Preserve quoted commas/newlines so exact identities cannot shift columns.
export function parseCsv(text) {
 const rows=[];let row=[],field='',quoted=false;
 for(let i=0;i<text.length;i++) {
  const c=text[i];
  if(c==='"') {
   if(quoted && text[i+1]==='"'){field+='"';i++;}
   else if(quoted) quoted=false;
   else if(!field) quoted=true;
   else throw new Error('quote inside unquoted CSV field');
  } else if(!quoted && (c===',' || c==='\n')) {
   row.push(field.replace(/\r$/,''));field='';
   if(c==='\n'){if(row.some(Boolean)) rows.push(row);row=[];}
  } else field+=c;
 }
 if(quoted) throw new Error('unterminated quoted CSV field');
 if(field || row.length){row.push(field.replace(/\r$/,''));if(row.some(Boolean)) rows.push(row);}
 return rows;
}
