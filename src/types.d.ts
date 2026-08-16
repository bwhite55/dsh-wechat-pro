/**
 * 可选依赖的类型声明：qrcode-terminal 仅用于把二维码渲染到终端，
 * 缺失时优雅回退为直接打印链接（try/catch 动态导入）。
 */
declare module 'qrcode-terminal' {
  interface GenerateOptions {
    small?: boolean
  }
  const qrcodeTerminal: {
    generate(text: string, options?: GenerateOptions): void
    default: { generate(text: string, options?: GenerateOptions): void }
  }
  export default qrcodeTerminal
}
