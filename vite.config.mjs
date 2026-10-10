import {defineConfig} from 'vite';
import fs from 'node:fs';
export default defineConfig({
 plugins:[{name:'tyw-development-entry',transformIndexHtml(html,ctx){return ctx.server?html.replace('<!-- TYW_STARTUP -->',`<style>${fs.readFileSync('web/startup.css','utf8')}</style><script src="/boot.js"></script><script type="module" src="/web/trade.ts"></script>`):html;}}],
 build:{target:'chrome80',manifest:true,rollupOptions:{input:{site:'index.html',trade:'web/trade.ts'}}}
});
