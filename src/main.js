import { Client, Databases, Query } from 'node-appwrite';
import { GoogleGenerativeAI } from '@google/generative-ai';

const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async ({ req, res, log, error }) => {
    try {
        log('Starting AI career matching...');
        
        const { talentId, careerStage, responses } = JSON.parse(req.body);

        if (!talentId || !careerStage || !responses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters' 
            }, 400);
        }

        log(`Processing career matching for talent: ${talentId}, stage: ${careerStage}`);

        // Fetch all available career paths
        const careerPaths = await databases.listDocuments(
            'career4me',
            'careerPaths',
            [Query.limit(100)]
        );

        if (careerPaths.documents.length === 0) {
            return res.json({ success: false, error: 'No career paths available' }, 404);
        }

        // Generate AI-powered career matches
        const matches = await generateAICareerMatches(
            talentId,
            careerStage,
            responses,
            careerPaths.documents,
            log
        );

        return res.json({
            success: true,
            matches: matches,
            totalPaths: careerPaths.documents.length,
            matchedPaths: matches.length
        });

    } catch (err) {
        error('Career matching failed:', err);
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate career matches'
        }, 500);
    }
};

async function generateAICareerMatches(talentId, careerStage, responses, careerPaths, log) {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    // Build context prompt based on career stage
    let contextPrompt = `CAREER MATCHING ANALYSIS - ${careerStage.toUpperCase()}\n\n`;
    contextPrompt += `User Profile:\n`;
    contextPrompt += `- Education: ${responses.educationLevel}`;
    if (responses.degreeProgram) {
        contextPrompt += ` in ${responses.degreeProgram}`;
    }
    contextPrompt += `\n- Current Skills: ${responses.currentSkills.join(', ')}`;
    contextPrompt += `\n- Desired Skills: ${responses.desiredSkills.join(', ')}`;
    contextPrompt += `\n- Interests: ${responses.interests.join(', ')}`;
    contextPrompt += `\n- Interested Fields: ${responses.interestedFields.join(', ')}`;

    // Add stage-specific context
    if (careerStage === 'Trailblazer') {
        contextPrompt += `\n- Current Path: ${responses.currentPath}`;
        contextPrompt += `\n- Years of Experience: ${responses.yearsOfExperience}`;
        contextPrompt += `\n- Seniority Level: ${responses.currentSeniorityLevel}`;
        contextPrompt += `\n- Career Goals: ${responses.careerGoals}`;
    } else if (careerStage === 'Horizon Changer') {
        contextPrompt += `\n- Current Path: ${responses.currentPath}`;
        contextPrompt += `\n- Years of Experience: ${responses.yearsOfExperience}`;
        contextPrompt += `\n- Seniority Level: ${responses.currentSeniorityLevel}`;
        contextPrompt += `\n- Current Work Environment: ${responses.currentWorkEnvironment}`;
        contextPrompt += `\n- Desired Work Environment: ${responses.desiredWorkEnvironment}`;
        contextPrompt += `\n- Reason for Change: ${responses.reasonForChange}`;
        contextPrompt += `\n- Change Urgency: ${responses.changeUrgency}`;
    } else if (careerStage === 'Pathfinder') {
        contextPrompt += `\n- Preferred Work Environment: ${responses.workEnvironment}`;
    }

    // Create career paths summary for AI
    const careerPathsSummary = careerPaths.map(path => ({
        id: path.$id,
        title: path.title,
        industry: path.industry,
        requiredSkills: path.requiredSkills || [],
        requiredInterests: path.requiredInterests || [],
        suggestedDegrees: path.suggestedDegrees || [],
        description: path.description || '',
        minSalary: path.minSalary || 0,
        maxSalary: path.maxSalary || 0,
        required_background: path.required_background || '',
        time_to_complete: path.time_to_complete || ''
    }));

    const analysisPrompt = `${contextPrompt}

AVAILABLE CAREER PATHS:
${JSON.stringify(careerPathsSummary, null, 2)}

ANALYSIS REQUIREMENTS:
1. Analyze based on user's career stage: ${careerStage}
2. Focus on:
   - Pathfinder: Entry requirements, learning potential, growth opportunities
   - Trailblazer: Career advancement, skill building, leadership opportunities
   - Horizon Changer: Transferable skills, transition feasibility, motivation alignment
3. Provide:
   - Match score (0-100)
   - Specific reasoning (speak directly to user)
   - User's strengths for this path
   - Areas needing development
   - Actionable recommendations
4. Return top 5 matches in JSON format`;

    try {
        log('Generating AI analysis...');
        const result = await model.generateContent(analysisPrompt);
        const aiResponse = result.response.text();
        
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('Invalid AI response format');
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        // Enrich matches with full career path data
        const enrichedMatches = analysisResult.matches.map(match => {
            const careerPath = careerPaths.find(path => path.$id === match.careerPathId);
            return careerPath ? {
                careerPath,
                matchScore: match.matchScore,
                reasoning: match.reasoning,
                strengths: match.strengths,
                developmentAreas: match.developmentAreas,
                recommendations: match.recommendations
            } : null;
        }).filter(match => match !== null);

        return enrichedMatches.sort((a, b) => b.matchScore - a.matchScore);

    } catch (err) {
        log('AI analysis failed, falling back to rule-based matching');
        return generateFallbackMatches(responses, careerPaths, careerStage);
    }
}

function generateFallbackMatches(responses, careerPaths, careerStage) {
    return careerPaths.map(path => {
        let score = 0;
        
        // Skills matching
        const skillMatches = (path.requiredSkills || []).filter(skill => 
            responses.currentSkills.includes(skill)
        ).length;
        score += skillMatches * 20;
        
        // Interest matching
        const interestMatches = (path.requiredInterests || []).filter(interest => 
            responses.interests.includes(interest)
        ).length;
        score += interestMatches * 15;
        
        // Field matching
        if (responses.interestedFields.includes(path.industry)) {
            score += 25;
        }
        
        // Career stage adjustments
        if (careerStage === 'Pathfinder' && path.required_background === 'Entry Level') {
            score += 10;
        } else if (careerStage === 'Trailblazer' && path.required_background !== 'Entry Level') {
            score += 10;
        } else if (careerStage === 'Horizon Changer' && path.required_background === 'Mid-Level') {
            score += 10;
        }
        
        return {
            careerPath: path,
            matchScore: Math.min(score, 100),
            reasoning: `Your profile matches this path based on your skills and interests.`,
            strengths: responses.currentSkills.slice(0, 3).map(skill => `You have experience with ${skill}`),
            developmentAreas: ['Focus on developing relevant skills', 'Build industry knowledge'],
            recommendations: ['Take relevant courses', 'Build portfolio projects', 'Network in the industry']
        };
    })
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);
}