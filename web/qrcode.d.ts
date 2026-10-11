// Minimal surface of the `qrcode` package used for the desktop wallet handoff.
declare module 'qrcode'{
 const QRCode:{toString(text:string,options?:{type?:'svg'|'utf8'|'terminal';margin?:number;errorCorrectionLevel?:'L'|'M'|'Q'|'H';color?:{dark?:string;light?:string}}):Promise<string>};
 export default QRCode;
}
