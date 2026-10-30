"""首页月度收支、上月支出、每日支出、分类支出和近十二个月支出。"""

from pydantic import BaseModel, Field


class DailyExpense(BaseModel):
    date: str = Field(description="本地日期，格式 YYYY-MM-DD")
    amount: str = Field(description="当日支出，两位小数字符串；无账单为 0.00")


class CategoryExpense(BaseModel):
    type: str = Field(description="支出类型编号，与账单 type 一致；不包含收入类型 6、7、9、10")
    amount: str = Field(description="该类型当月支出，两位小数字符串")


class MonthlyExpense(BaseModel):
    month: str = Field(description="统计月份，格式 YYYY-MM")
    amount: str = Field(description="该月支出，两位小数字符串；无支出为 0.00")


class DashboardStatistics(BaseModel):
    month: str = Field(description="统计月份，格式 YYYY-MM")
    income: str = Field(description="当月收入，两位小数字符串")
    expense: str = Field(description="当月支出，两位小数字符串")
    previousMonthExpense: str = Field(description="上个完整自然月支出，两位小数字符串")
    dailyExpenses: list[DailyExpense] = Field(description="当月每日支出，按日期升序，包含所有零支出日期")
    categoryExpenses: list[CategoryExpense] = Field(description="当月各支出类型汇总，按类型编号升序；只包含金额大于零的类型，空月为空列表")
    monthlyExpenses: list[MonthlyExpense] = Field(description="含统计当月的最近十二个月支出，按月份升序，补齐零支出月份；数据库下界截到 1000-01")
