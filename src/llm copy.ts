import EventEmitter from 'events';
import OpenAI from 'openai';
import axios from 'axios';

export class Llm extends EventEmitter {
  private openai: OpenAI;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private userContext: any[];
  private partialResponseIndex: number;
  private tools: any[];

  constructor() {
    super();
    this.openai = new OpenAI();
    this.userContext = [
      {
        role: 'system',
        content:
          'You are a helpful assistant called Emily. You work at barbershop helping getting appointments. If the time user asks is already booked, suggest the closest. Keep your responses short and to the point. This is a conversation you are having with a person, so keep it natural and casual. If you think user hasnt finished his thought, leave your response empty or say hm or aha (casual)',
      },
      {
        role: 'assistant',
        content: 'Hi, my name is Emily. How can I help you?',
      },
    ];
    this.tools = [
      {
        type: 'function',
        function: {
          name: 'fetchSchedule',
          description: 'Get info about available dates and time',
          parameters: {
            type: 'object',
            properties: {
              day: {
                type: 'string',
                description: 'Day of the week',
              },
              time: {
                type: 'string',
                description: 'Time of the appointment',
              },
            },
            additionalProperties: false,
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'UpdateSchedule',
          description: 'Update the schedule with a new appointment.',
          parameters: {
            type: 'object',
            properties: {
              day: {
                type: 'string',
                description: 'Day of the week for the appointment',
              },
              time: {
                type: 'string',
                description: 'Time of the appointment',
              },
              status: {
                type: 'string',
                description: 'Status of the appointment (Available or Booked)',
              },
            },
            require: ['day', 'time', 'status'],
            additionalProperties: false,
          },
        },
      },
    ];
    this.partialResponseIndex = 0;
  }

  // Add the callSid to the chat context
  setCallSid(callSid: string) {
    this.userContext.push({ role: 'system', content: `callSid: ${callSid}` });
  }

  updateUserContext(name: string, role: string, text: string) {
    this.userContext.push({ role: role, name: name, content: text });
  }

  async completion(text: string, role = 'user', name = 'user') {
    this.updateUserContext(name, role, text);

    // Send user transcription to LLM
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: this.userContext,
      stream: true,
      tools: this.tools,
    });

    let completeResponse = '';
    let partialResponse = '';
    let finishReason = '';
    let scheduleInfo;
    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content || '';
      finishReason = chunk.choices[0]?.finish_reason ?? '';

      completeResponse += content;
      partialResponse += content;

      if (chunk.choices[0]?.delta?.tool_calls) {
        const functionCall = chunk.choices[0].delta.tool_calls[0];

        if (functionCall?.function?.name === 'fetchSchedule') {
          const interimMessage = 'Could you wait while I check the info?';
          this.userContext.push({ role: 'assistant', content: interimMessage });
          this.emit('llmreply', {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse: interimMessage,
          });

          this.partialResponseIndex++;
          partialResponse = ''; 

          scheduleInfo = await this.fetchSchedule();
          this.userContext.push({
            role: 'system',
            content: `Schedule information: ${JSON.stringify(scheduleInfo)}`,
          });

          const llmResponseStream = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: this.userContext,  
            stream: true,
          });

          let assistantResponse = '';
          for await (const llmChunk of llmResponseStream) {
            const llmContent = llmChunk.choices[0]?.delta?.content || '';
            assistantResponse += llmContent;
            partialResponse += llmContent;

            if (llmContent.trim().slice(-1) === '•' || llmChunk.choices[0]?.finish_reason === 'stop') {
              this.emit('llmreply', {
                partialResponseIndex: this.partialResponseIndex,
                partialResponse,
              });
              this.partialResponseIndex++;
              partialResponse = '';
              return;
            }
          }

          this.userContext.push({ role: 'assistant', content: assistantResponse });
        }

        if (functionCall?.function?.name === 'UpdateSchedule') {
          const interimMessage = 'Sure, let me book your appointment. Just a second.';
          this.userContext.push({ role: 'assistant', content: interimMessage });
          this.emit('llmreply', {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse: interimMessage,
          });

          this.partialResponseIndex++;
          partialResponse = ''; 

         

          //const updateResult = await this.UpdateSchedule(updatedSchedule);
          // this.userContext.push({
          //   role: 'system',
          //   content: `Schedule update result: ${JSON.stringify(updateResult)}`,
          // });

          const llmResponseStream = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: this.userContext,
            stream: true,
          });

          let assistantResponse = '';
          for await (const llmChunk of llmResponseStream) {
            const llmContent = llmChunk.choices[0]?.delta?.content || '';
            assistantResponse += llmContent;
            partialResponse += llmContent;

            if (llmContent.trim().slice(-1) === '•' || llmChunk.choices[0]?.finish_reason === 'stop') {
              this.emit('llmreply', {
                partialResponseIndex: this.partialResponseIndex,
                partialResponse,
              });
              this.partialResponseIndex++;
              partialResponse = '';
              return;
            }
          }

          this.userContext.push({ role: 'assistant', content: assistantResponse });
        }
      }

      if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
        this.emit('llmreply', {
          partialResponseIndex: this.partialResponseIndex,
          partialResponse,
        });
        this.partialResponseIndex++;
        partialResponse = '';
      }
    }

    this.userContext.push({ role: 'assistant', content: completeResponse });
  }

  async fetchSchedule() {
    try {
      const response = await axios.get(`https://barberback-4yttqpvo6q-lm.a.run.app/lWvb4McBtFbpMGQfnlrc`);
      return response.data;
    } catch (error) {
      console.error('Error fetching schedule:', error);
      throw new Error('Failed to fetch schedule');
    }
  }

  async UpdateSchedule(day:any, time:any, status:any) {
    console.log('Updating schedule with:', day, time, status);
    const updatedSchedule = {
      day: day,
      time: time,
      status: status,
    };
    try {
      const response = await fetch('https://barberback-4yttqpvo6q-lm.a.run.app/lWvb4McBtFbpMGQfnlrc', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updatedSchedule),
      });

      if (!response.ok) {
        throw new Error('Failed to update schedule');
      }

      const result = await response.json();
      console.log('Schedule updated successfully!', result);
      return result;
    } catch (error) {
      console.error('Error updating schedule:', error);
      throw error;
    }
  }
}
