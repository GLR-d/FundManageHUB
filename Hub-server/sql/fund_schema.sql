CREATE TABLE IF NOT EXISTS funds (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id BIGINT UNSIGNED NOT NULL,
    time DATETIME NOT NULL,
    type TINYINT UNSIGNED NOT NULL,
    amount DECIMAL(16,2) NOT NULL,
    remark VARCHAR(50) NOT NULL DEFAULT '',
    photo TEXT NOT NULL,
    PRIMARY KEY (id),
    KEY idx_funds_user_time (user_id, time),
    CONSTRAINT fk_funds_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT chk_funds_type CHECK (type BETWEEN 0 AND 10),
    CONSTRAINT chk_funds_amount CHECK (amount BETWEEN 0 AND 90071992547409.91)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
