declare module 'sql.js' {
  interface Database {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run(sql: string, params?: any[]): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    exec(sql: string): { columns: string[]; values: any[][] }[];
    export(): Uint8Array;
    close(): void;
  }
  interface SqlJsStatic {
    Database: new (data?: ArrayLike<number>) => Database;
  }
  function initSqlJs(): Promise<SqlJsStatic>;
  export default initSqlJs;
  export { Database, SqlJsStatic };
}
