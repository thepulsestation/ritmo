import {copyFile,mkdir,readFile,writeFile} from 'node:fs/promises';
await mkdir('supabase/functions/ritmo-push',{recursive:true});await copyFile('domain.js','supabase/functions/ritmo-push/domain.js');
const domain=(await readFile('domain.js','utf8')).replaceAll('export ','');const code=(await readFile('supabase/functions/ritmo-push/index.ts','utf8')).replace("import {dueNotifications} from './domain.js';",domain);
await mkdir('.private',{recursive:true});await writeFile('.private/edge-deploy.ts',code);console.log('Edge function prepared.');
