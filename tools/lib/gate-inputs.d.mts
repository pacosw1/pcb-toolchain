export interface GateInputRecord {path:string;sha256:string|null;link?:string}
export function gateInputs(root:string,board:string,configName?:string,environment?:{configDir?:string;variables?:Record<string,string>;repositories?:string[]}):{cfg:unknown;project:string;files:string[]};
export function fingerprint(root:string,files:string[],versions?:Record<string,string>,externalRoots?:Record<string,string>):{input_sha256:string;inputs:GateInputRecord[];tools:Record<string,string>};
