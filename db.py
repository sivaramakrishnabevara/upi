"""
PhonePe Business MySQL Database Integration
===========================================
Database: phone
Table: transactions
Columns:
  - id
  - transaction_id
  - operator_id (formerly transaction_note)
  - name
  - amount
  - merchant_id
  - status
  - transaction_date
  - created_at
"""

import sys
import pymysql

if sys.platform.startswith("win"):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

import os

DB_CONFIG = {
    "host": os.environ.get("DB_HOST", "localhost"),
    "user": os.environ.get("DB_USER", "root"),
    "password": os.environ.get("DB_PASSWORD", "Sivaa@2004"),
    "database": os.environ.get("DB_NAME", "phone"),
    "autocommit": True,
}


def get_connection():
    """Returns a pymysql connection to the 'phone' database."""
    return pymysql.connect(**DB_CONFIG)


def init_db():
    """Creates the transactions table if it doesn't already exist, and ensures operator_id and name columns are present."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS transactions (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    transaction_id VARCHAR(100) UNIQUE,
                    operator_id VARCHAR(255),
                    name VARCHAR(255),
                    amount DECIMAL(10, 2),
                    merchant_id VARCHAR(100),
                    status VARCHAR(50),
                    transaction_date VARCHAR(100),
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
                )
            """)

            # Ensure operator_id exists (rename from legacy transaction_note if present)
            try:
                cur.execute("""
                    SELECT COLUMN_NAME 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_SCHEMA = DATABASE() 
                      AND TABLE_NAME = 'transactions' 
                      AND COLUMN_NAME = 'transaction_note'
                """)
                has_note = cur.fetchone()

                cur.execute("""
                    SELECT COLUMN_NAME 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_SCHEMA = DATABASE() 
                      AND TABLE_NAME = 'transactions' 
                      AND COLUMN_NAME = 'operator_id'
                """)
                has_op = cur.fetchone()

                if has_note and not has_op:
                    cur.execute("ALTER TABLE transactions CHANGE COLUMN transaction_note operator_id VARCHAR(255)")
                    print("✅ Renamed column 'transaction_note' to 'operator_id' in transactions table.")
                elif not has_op:
                    cur.execute("ALTER TABLE transactions ADD COLUMN operator_id VARCHAR(255) AFTER transaction_id")
                    print("✅ Column 'operator_id' added to transactions table.")
            except Exception:
                pass

            # Ensure name column exists
            try:
                cur.execute("""
                    SELECT COLUMN_NAME 
                    FROM INFORMATION_SCHEMA.COLUMNS 
                    WHERE TABLE_SCHEMA = DATABASE() 
                      AND TABLE_NAME = 'transactions' 
                      AND COLUMN_NAME = 'name'
                """)
                if not cur.fetchone():
                    cur.execute("ALTER TABLE transactions ADD COLUMN name VARCHAR(255) AFTER operator_id")
                    print("✅ Column 'name' added to transactions table.")
            except Exception:
                pass

        print("✅ MySQL table 'transactions' verified/created.")
    finally:
        conn.close()


def save_transaction(txn: dict) -> bool:
    """
    Inserts or updates a single transaction into MySQL.
    Expects keys: transaction_id, operator_id (or transaction_note), name, amount, merchant_id, status, transaction_date
    """
    conn = get_connection()
    try:
        op_val = txn.get("operator_id") or txn.get("transaction_note")
        name_val = txn.get("name")
        with conn.cursor() as cur:
            sql = """
                INSERT INTO transactions (transaction_id, operator_id, name, amount, merchant_id, status, transaction_date)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    operator_id = IF(VALUES(operator_id) IS NOT NULL AND VALUES(operator_id) != '', VALUES(operator_id), transactions.operator_id),
                    name = IF(VALUES(name) IS NOT NULL AND VALUES(name) != '' AND VALUES(name) != 'N/A' AND VALUES(name) != 'Customer', VALUES(name), transactions.name),
                    amount = VALUES(amount),
                    merchant_id = VALUES(merchant_id),
                    status = VALUES(status),
                    transaction_date = VALUES(transaction_date)
            """
            cur.execute(
                sql,
                (
                    txn.get("transaction_id"),
                    op_val,
                    name_val,
                    txn.get("amount", 0.0),
                    txn.get("merchant_id"),
                    txn.get("status", "COMPLETED"),
                    str(txn.get("transaction_date", "")),
                ),
            )
        return True
    except Exception as e:
        print(f"⚠️ Error saving transaction to DB: {e}")
        return False
    finally:
        conn.close()


def save_multiple_transactions(txn_list: list) -> int:
    """Inserts or updates a list of transactions into MySQL in a single high-speed batch query."""
    if not txn_list:
        return 0
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            sql = """
                INSERT INTO transactions (transaction_id, operator_id, name, amount, merchant_id, status, transaction_date)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON DUPLICATE KEY UPDATE
                    operator_id = IF(VALUES(operator_id) IS NOT NULL AND VALUES(operator_id) != '', VALUES(operator_id), transactions.operator_id),
                    name = IF(VALUES(name) IS NOT NULL AND VALUES(name) != '' AND VALUES(name) != 'N/A', VALUES(name), transactions.name),
                    amount = VALUES(amount),
                    merchant_id = VALUES(merchant_id),
                    status = VALUES(status),
                    transaction_date = VALUES(transaction_date)
            """
            params = [
                (
                    txn.get("transaction_id"),
                    txn.get("operator_id") or txn.get("transaction_note"),
                    txn.get("name"),
                    txn.get("amount", 0.0),
                    txn.get("merchant_id"),
                    txn.get("status", "COMPLETED"),
                    str(txn.get("transaction_date", "")),
                )
                for txn in txn_list
            ]
            cur.executemany(sql, params)
            return len(params)
    except Exception as e:
        print(f"⚠️ Error batch saving transactions: {e}")
        return 0
    finally:
        conn.close()


def get_all_transactions(limit: int = 200):
    """Retrieves all transactions from MySQL (default limit: 200)."""
    conn = get_connection()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, transaction_id, operator_id, name, amount, merchant_id, status, transaction_date, created_at FROM transactions ORDER BY id DESC LIMIT %s",
                (limit,),
            )
            rows = cur.fetchall()
            for r in rows:
                # Backward-compatibility alias: transaction_note points to operator_id
                r["transaction_note"] = r.get("operator_id")
            return rows
    finally:
        conn.close()


def find_transaction_by_id(txn_id: str):
    """Finds a transaction in MySQL by transaction ID."""
    if not txn_id:
        return None
    conn = get_connection()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, transaction_id, operator_id, name, amount, merchant_id, status, transaction_date FROM transactions WHERE transaction_id = %s LIMIT 1",
                (txn_id,),
            )
            row = cur.fetchone()
            if row:
                row["transaction_note"] = row.get("operator_id")
            return row
    finally:
        conn.close()


def find_transaction_by_operator_id(op_id: str):
    """Finds a transaction in MySQL by operator_id or transaction ID."""
    if not op_id:
        return None
    conn = get_connection()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, transaction_id, operator_id, name, amount, merchant_id, status, transaction_date FROM transactions WHERE operator_id = %s OR transaction_id = %s LIMIT 1",
                (op_id, op_id),
            )
            row = cur.fetchone()
            if row:
                row["transaction_note"] = row.get("operator_id")
            return row
    finally:
        conn.close()


# Backward compatible function alias
find_transaction_by_note = find_transaction_by_operator_id


def find_transaction(query_str: str):
    """Finds a transaction in MySQL by matching transaction_id, operator_id, or customer name."""
    if not query_str:
        return None
    conn = get_connection()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                """
                SELECT id, transaction_id, operator_id, name, amount, merchant_id, status, transaction_date 
                FROM transactions 
                WHERE transaction_id = %s OR operator_id = %s OR name LIKE %s
                LIMIT 1
                """,
                (query_str, query_str, f"%{query_str}%"),
            )
            row = cur.fetchone()
            if row:
                row["transaction_note"] = row.get("operator_id")
            return row
    finally:
        conn.close()


def get_max_transaction_id() -> int:
    """Returns the maximum transaction id currently in the table."""
    conn = get_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT COALESCE(MAX(id), 0) FROM transactions")
            row = cur.fetchone()
            return int(row[0]) if row and row[0] is not None else 0
    except Exception:
        return 0
    finally:
        conn.close()


def get_transactions_since_id(last_id: int):
    """Retrieves all transactions from MySQL with id > last_id ordered by id ASC."""
    conn = get_connection()
    try:
        with conn.cursor(pymysql.cursors.DictCursor) as cur:
            cur.execute(
                "SELECT id, transaction_id, operator_id, name, amount, merchant_id, status, transaction_date, created_at FROM transactions WHERE id > %s ORDER BY id ASC",
                (last_id,),
            )
            rows = cur.fetchall()
            for r in rows:
                r["transaction_note"] = r.get("operator_id")
            return rows
    except Exception:
        return []
    finally:
        conn.close()


if __name__ == "__main__":
    init_db()
    rows = get_all_transactions(10)
    print(f"\n📊 Total records in DB: {len(rows)}")
    for r in rows:
        print(f"ID: {r['id']} | TxnID: {r['transaction_id']} | OperatorID: {r['operator_id']} | Name: {r['name']} | Amount: ₹{r['amount']} | Status: {r['status']}")
