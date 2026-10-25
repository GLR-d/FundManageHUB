"""账单分类的固定编号；新增类型只能追加，保留历史账单含义。"""

import re

FUND_TYPES = ("消费", "餐饮", "购物", "住房", "娱乐", "其他", "薪资", "理财", "交通", "收转账", "收红包")
FUND_TYPE_CODES = frozenset(str(index) for index in range(len(FUND_TYPES)))
INCOME_TYPES = frozenset({"6", "7", "9", "10"})
EXPENSE_TYPES = FUND_TYPE_CODES - INCOME_TYPES
FUND_TYPE_MAX = len(FUND_TYPES) - 1
FUND_TYPE_CHECK = f"type BETWEEN 0 AND {FUND_TYPE_MAX}"


def fund_type_check_upper_bound(expression: str) -> int | None:
    """只识别应用已有的类型范围约束，避免迁移覆盖自定义约束。"""
    normalized = re.sub(r"[\s`()]+", "", expression.lower())
    match = re.fullmatch(r"typebetween0and([0-9]+)", normalized)
    return int(match.group(1)) if match else None
