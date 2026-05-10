// Stub types for test fixture
interface Database {
  query(sql: string, params: string[]): Promise<User>
  execute(sql: string, params: string[]): Promise<void>
}
interface User {
  id: string
  name: string
}

export class UserService {
  private db: Database

  constructor(db: Database) {
    this.db = db
  }

  async getUser(id: string): Promise<User> {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id])
  }

  async deleteUser(id: string): Promise<void> {
    await this.db.execute('DELETE FROM users WHERE id = ?', [id])
  }
}

export function helperFunction(input: string): string {
  return input.trim().toLowerCase()
}

export const MAX_RETRIES = 3
