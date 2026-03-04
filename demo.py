from agents import Agent as OpenAIAgent, Runner
from agents.tool import function_tool
from dotenv import load_dotenv

import asyncio
load_dotenv()

from browser_use import Agent as BrowserAgent, ChatOpenAI, Tools, ActionResult, Browser
from browser_use.code_use import CodeAgent


@function_tool
async def Automation(task: str):
    llm = ChatOpenAI(model="gpt-4.1-mini")
    agent = BrowserAgent(
        task=task,
        llm=llm
    )
    await agent.run()


@function_tool
async def required_info(question: str) -> str:
    answer = input(f'{question} > ')
    return f'The human responded with: {answer}'
    

# connection with the agent
async def main():
    agent = OpenAIAgent(
        name="Automation Agent",
        instructions="You are a helpful assistant that can perform automated tasks and always use the Automation tool for the automation task , don't try to ask that is not possible or something like that.  Do **not** call the `required_info` tool at the beginning. Only use it when absolutely necessary to obtain specific information from the user that is essential for completing the task.",
        tools=[Automation, required_info],
    )

    user_input = input("User: ")

    result = await Runner.run(agent, user_input)
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
