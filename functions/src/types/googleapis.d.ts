declare module 'googleapis' {
  export const google: {
    auth: {
      GoogleAuth: new (options: any) => {
        getClient(): Promise<any>
      }
    }
    sheets(options: any): any
  }

  export namespace sheets_v4 {
    type Sheets = any
  }
}
