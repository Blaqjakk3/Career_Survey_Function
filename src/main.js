const { Client, Databases, Query } = require('node-appwrite');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Initialize client
const client = new Client()
    .setEndpoint(process.env.APPWRITE_FUNCTION_ENDPOINT || 'https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID || '67d074d0001dadc04f94')
    .setKey(process.env.APPWRITE_API_KEY);

const databases = new Databases(client);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

module.exports = async ({ req, res, log, error }) => {
    try {
        log('Starting AI career matching...');
        
        const { talentId, careerStage, responses } = JSON.parse(req.body);

        if (!talentId || !careerStage || !responses) {
            return res.json({ 
                success: false, 
                error: 'Missing required parameters: talentId, careerStage, and responses' 
            }, 400);
        }

        log(`Processing career matching for talent: ${talentId}, stage: ${careerStage}`);

        // Fetch all available career paths
        const careerPathsQuery = await databases.listDocuments(
            'career4me',
            'careerPaths',
            [Query.limit(100)]
        );

        if (careerPathsQuery.documents.length === 0) {
            return res.json({ success: false, error: 'No career paths available' }, 404);
        }

        // Fetch talent details
        const talentQuery = await databases.listDocuments(
            'career4me',
            'talents',
            [Query.equal('talentId', talentId)]
        );

        if (talentQuery.documents.length === 0) {
            return res.json({ success: false, error: 'Talent not found' }, 404);
        }

        const talent = talentQuery.documents[0];

        // Get current career path details if available
        let currentCareerPath = null;
        if (responses.currentPath) {
            try {
                currentCareerPath = await databases.getDocument(
                    'career4me',
                    'careerPaths',
                    responses.currentPath
                );
            } catch (err) {
                log(`Warning: Could not fetch current career path: ${responses.currentPath}`);
            }
        }

        // Generate AI-powered career matches
        const matches = await generateAICareerMatches(
            talent,
            careerStage,
            responses,
            careerPathsQuery.documents,
            currentCareerPath,
            log
        );

        log('Career matching completed successfully');
        return res.json({
            success: true,
            matches: matches,
            totalPaths: careerPathsQuery.documents.length,
            matchedPaths: matches.length
        });

    } catch (err) {
        error('Career matching failed:', err);
        return res.json({ 
            success: false, 
            error: err.message || 'Failed to generate career matches',
            details: process.env.NODE_ENV === 'development' ? err.stack : undefined
        }, 500);
    }
};

async function generateAICareerMatches(talent, careerStage, responses, careerPaths, currentCareerPath, log) {
    const model = genAI.getGenerativeModel({ model: 'gemini-1.5-flash' });

    // Build comprehensive context for AI analysis
    const contextPrompt = buildContextPrompt(talent, careerStage, responses, currentCareerPath);
    
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
1. Analyze the user's profile against each career path
2. Consider career stage-specific factors:
   - Pathfinder: Focus on learning potential, entry requirements, growth opportunities
   - Trailblazer: Focus on career advancement, skill building, leadership opportunities  
   - Horizon Changer: Focus on transferable skills, transition feasibility, motivation alignment

3. Provide detailed matching with:
   - Match score (0-100)
   - Specific reasoning for the match
   - User's strengths for this path
   - Areas needing development
   - Actionable recommendations

4. Return top 5 matches in JSON format:
{
  "matches": [
    {
      "careerPathId": "path_id",
      "matchScore": 85,
      "reasoning": "Detailed explanation of why this path matches",
      "strengths": ["strength1", "strength2", "strength3"],
      "developmentAreas": ["area1", "area2"],
      "recommendations": ["rec1", "rec2", "rec3"]
    }
  ]
}

Focus on realistic, actionable matches that consider the user's current situation and career stage.`;

    try {
        log('Generating AI analysis...');
        const result = await model.generateContent(analysisPrompt);
        const aiResponse = result.response.text();
        
        // Extract JSON from AI response
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('AI response does not contain valid JSON');
        }
        
        const analysisResult = JSON.parse(jsonMatch[0]);
        
        // Enrich matches with full career path data
        const enrichedMatches = analysisResult.matches.map(match => {
            const careerPath = careerPaths.find(path => path.$id === match.careerPathId);
            return {
                careerPath: careerPath,
                matchScore: match.matchScore,
                reasoning: match.reasoning,
                strengths: match.strengths,
                developmentAreas: match.developmentAreas,
                recommendations: match.recommendations
            };
        }).filter(match => match.careerPath); // Remove any matches where career path wasn't found

        // Sort by match score descending
        enrichedMatches.sort((a, b) => b.matchScore - a.matchScore);
        
        log(`Generated ${enrichedMatches.length} career matches`);
        return enrichedMatches;

    } catch (err) {
        log('AI analysis failed, falling back to rule-based matching');
        
        // Fallback to simpler rule-based matching
        return generateFallbackMatches(responses, careerPaths, careerStage);
    }
}

function buildContextPrompt(talent, careerStage, responses, currentCareerPath) {
    const careerStageDescriptions = {
        'Pathfinder': 'Someone finding their feet in career life, looking for their career and learning',
        'Trailblazer': 'Someone with a career looking to continue growth',
        'Horizon Changer': 'Someone in a career path looking to pivot to another one'
    };

    let prompt = `CAREER MATCHING ANALYSIS

USER PROFILE:
- Name: ${talent.fullname}
- Career Stage: ${careerStage} (${careerStageDescriptions[careerStage]})
- Age: ${calculateAge(talent.dateofBirth)}
- Education: ${responses.degrees.join(', ')}
- Current Skills: ${responses.skills.join(', ')}
- Interests: ${responses.interests.join(', ')}
- Interested Fields: ${responses.interestedFields.join(', ')}`;

    if (currentCareerPath) {
        prompt += `\n- Current Career Path: ${currentCareerPath.title} (${currentCareerPath.industry})`;
        prompt += `\n- Current Seniority Level: ${responses.currentSeniorityLevel}`;
    }

    if (responses.additionalContext) {
        prompt += `\n- Additional Context: ${responses.additionalContext}`;
    }

    return prompt;
}

function calculateAge(dateOfBirth) {
    if (!dateOfBirth) return 'Not specified';
    
    const birth = new Date(dateOfBirth);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
    }
    
    return age;
}

function generateFallbackMatches(responses, careerPaths, careerStage) {
    // Simple rule-based matching as fallback
    const matches = careerPaths.map(path => {
        let score = 0;
        
        // Skills matching
        const skillMatches = (path.requiredSkills || []).filter(skill => 
            responses.skills.includes(skill)
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
        
        // Education matching
        const hasRequiredEducation = (path.suggestedDegrees || []).some(degree => 
            responses.degrees.includes(degree)
        );
        if (hasRequiredEducation) {
            score += 20;
        }
        
        // Career stage specific adjustments
        if (careerStage === 'Pathfinder' && path.required_background === 'Entry Level') {
            score += 10;
        }
        
        return {
            careerPath: path,
            matchScore: Math.min(score, 100),
            reasoning: `Matched based on ${skillMatches} skills, ${interestMatches} interests, and field alignment.`,
            strengths: responses.skills.slice(0, 3),
            developmentAreas: ['Technical Skills', 'Industry Knowledge'],
            recommendations: ['Take relevant courses', 'Build portfolio projects', 'Network in the industry']
        };
    });
    
    // Return top 5 matches
    return matches
        .sort((a, b) => b.matchScore - a.matchScore)
        .slice(0, 5);
}