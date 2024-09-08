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
          'You are a helpful assistant called Emma. You help get information about companies. If user asks about information on the company as what specific info is needed, dont provide full info. Keep your responses short and to the point. This is a conversation you are having with a person, so keep it natural and casual. If you think user hasnt finished his thought, leave your response empty or say hm or aha',
      },
      {
        role: 'assistant',
        content: 'Hi, my name is Emma. How can I help you?',
      },
    ];
    this.tools = [
      {
        type: "function",
        function: {
          name: "fetchCompanyInfo",
          description: "Get specific info about the company by mc number like phone number, or address. Don't provide full info. ",
          parameters: {
            type: "object",
            properties: {
              mc_number: {
                type: "string",
                description: "The company mc number",
              },
            },
            required: ["mc_number"],
            additionalProperties: false,
          },
        }
      }
    ];
    this.partialResponseIndex = 0;
  }

  // Add the callSid to the chat context in case
  // LLM decides to transfer the call.
  setCallSid(callSid: string) {
    this.userContext.push({ role: 'system', content: `callSid: ${callSid}` });
  }

  updateUserContext(name: string, role: string, text: string) {
    if (name !== 'user') {
      this.userContext.push({ role: role, name: name, content: text });
    } else {
      this.userContext.push({ role: role, content: text });
    }
  }

  async completion(text: string, role = 'user', name = 'user') {
    this.updateUserContext(name, role, text);

    // Helper function to fetch company info

    // Step 1: Send user transcription to LLM
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o',
      messages: this.userContext,
      stream: true,
      tools: this.tools,
    });

    let completeResponse = '';
    let partialResponse = '';
    let finishReason = '';

    for await (const chunk of stream) {

      const content = chunk.choices[0]?.delta?.content || '';
      finishReason = chunk.choices[0]?.finish_reason ?? '';
      console.dir(chunk.choices[0]?.delta.tool_calls);
      // We use completeResponse for userContext
      completeResponse += content;
      partialResponse += content;

      // Emit last partial response and add complete response to userContext
      if (chunk.choices[0]?.delta?.tool_calls) {
        
        const functionCall = chunk.choices[0].delta.tool_calls[0];
       // console.dir(functionCall);
        //console.log('Function call:', functionCall?.function?.arguments);
        // const args= JSON.parse(functionCall?.function?.arguments || '{}') 
        
        if (functionCall?.function?.name === 'fetchCompanyInfo') {
        // const mc_number = args.mc_number;
        // console.log('MC Number:', mc_number);
          // Fetch the company information
          const interimMessage = "Could you wait while I check the info?";
          this.userContext.push({ role: 'assistant', content: interimMessage });
          this.emit('llmreply', {
            partialResponseIndex: this.partialResponseIndex,
            partialResponse: interimMessage,
          });

          this.partialResponseIndex++;
          partialResponse = ''; // Reset partial response for the next one
          const companyInfo = await this.fetchCompanyInfo();

          // Add the fetched company info as hidden context for LLM's reference
          this.userContext.push({
            role: 'system',
            content: `Company information: ${JSON.stringify(companyInfo)}`,
          });

          // After the function call, continue streaming the LLM's response
          const llmResponseStream = await this.openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: this.userContext,  // Now the LLM has the company info in context
            stream: true,
          });

          let assistantResponse = '';
          for await (const llmChunk of llmResponseStream) {
            const llmContent = llmChunk.choices[0]?.delta?.content || '';
            assistantResponse += llmContent;
            partialResponse += llmContent;

            if (llmContent.trim().slice(-1) === '•' || llmChunk.choices[0]?.finish_reason === 'stop') {
              const llmReply = {
                partialResponseIndex: this.partialResponseIndex,
                partialResponse,
              };

              this.emit('llmreply', llmReply);
              this.partialResponseIndex++;
              partialResponse = '';
              return;
            }
          }


          this.userContext.push({ role: 'assistant', content: assistantResponse });
        }
      }

      
      if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
        const llmReply = {
          partialResponseIndex: this.partialResponseIndex,
          partialResponse,
        };

        this.emit('llmreply', llmReply);
        this.partialResponseIndex++;
        partialResponse = '';
      }
    }

    // Add the final complete response to the conversation history
    this.userContext.push({ role: 'assistant', content: completeResponse });
  }

  async fetchCompanyInfo() {
    try {
      const response = await axios.get(`https://jsback-410227115786.europe-central2.run.app`);
      return response.data;
    } catch (error) {
      console.error('Error fetching company info:', error);
      throw new Error('Failed to fetch company information');
    }
  }

}